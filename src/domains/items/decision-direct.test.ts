import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { listCommands } from '@platform/commands/store.js';
import type { Discussion } from '@platform/github/github.js';

// An adjustment in words or the answers to the questions, asked straight to
// ronin (#446): a command, and the PR's run woken now; nothing on GitHub.
const pendingReview = vi.fn();
const submitReview = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('@platform/github/github-as-user.js', () => ({
  pendingReview: (...args: unknown[]) => pendingReview(...args),
  submitReview: (...args: unknown[]) => submitReview(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
  discardReview: vi.fn(),
  closePr: vi.fn(),
  closeIssue: vi.fn(),
}));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const { runDecision } = await import('./decision.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const SESSION = { login: 'ana-dev', token: 'gho_user' };
const FILES = { fetchedAt: '', prId: 'PR_1', author: 'ronin-agent', headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), files: [], threads: [] };
const PR: Discussion = { number: 918, title: 't', body: '', author: 'ronin-agent', createdAt: '', url: '', state: 'OPEN', isDraft: false, labels: [], comments: [], mergeable: 'MERGEABLE', headRefName: 'ronin/912/slice-1' };
const target = (pr: Partial<Discussion> = {}) => ({ prNumber: 918, issueNumber: 912, files: FILES, pr: { ...PR, ...pr } });

describe.skipIf(!TEST_DATABASE_URL)('deciding a PR straight to ronin', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const wake = vi.fn(async () => {});
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    vi.clearAllMocks();
    pendingReview.mockResolvedValue(null);
    commentOnIssue.mockResolvedValue({ url: 'https://github.com/acme/product/pull/918#issuecomment-1' });
    await db.deleteFrom('commands').execute();
  });

  it('keeps an adjustment as a command and wakes the PR and its issue, without a comment', async () => {
    const done = await runDecision(ENTRY, target(), SESSION, { decision: 'adjust', text: 'Agregá un test para el total en cero' }, 'ronin-agent', wake);
    expect(done.command).toMatchObject({ repo: 'acme/product', number: 918, kind: 'adjust', requestedBy: 'ana-dev', args: { text: 'Agregá un test para el total en cero' }, status: 'queued' });
    expect(wake).toHaveBeenCalledWith('acme/product', ['pr-918', 'issue-912']);
    expect(commentOnIssue).not.toHaveBeenCalled();
    const answered = await runDecision(ENTRY, target(), SESSION, { decision: 'answer', text: '1. Sí' }, 'ronin-agent', wake);
    expect(answered.command?.kind).toBe('answer');
    expect((await listCommands(db, 'acme/product', [918])).map((c) => c.kind)).toEqual(['answer', 'adjust']);
  });

  it('keeps on GitHub what lives there: line comments from Archivos, a spec, or no way to wake the run', async () => {
    pendingReview.mockResolvedValueOnce({ id: 'PRR_1', threads: [] });
    await runDecision(ENTRY, target(), SESSION, { decision: 'adjust', text: 'Mirá los comentarios' }, 'ronin-agent', wake);
    expect(commentOnIssue).toHaveBeenLastCalledWith('gho_user', 'acme/product', 918, '@ronin-agent /fix-comments\n\nMirá los comentarios');
    await runDecision(ENTRY, target({ headRefName: 'ronin/912/spec' }), SESSION, { decision: 'adjust', text: 'Otra sección' }, 'ronin-agent', wake);
    expect(commentOnIssue).toHaveBeenLastCalledWith('gho_user', 'acme/product', 918, '@ronin-agent Otra sección');
    await runDecision(ENTRY, target(), SESSION, { decision: 'adjust', text: 'Sin cola' }, 'ronin-agent');
    expect(commentOnIssue).toHaveBeenLastCalledWith('gho_user', 'acme/product', 918, '@ronin-agent Sin cola');
    expect(await listCommands(db, 'acme/product', [918])).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});
