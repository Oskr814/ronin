import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';

// A preview asked from the tablero (#446): kept as a command and its worker
// launched with it, without a word on GitHub.
const launchPreviewWorker = vi.fn();
vi.mock('../previews/index.js', () => ({ launchPreviewWorker: (...args: unknown[]) => launchPreviewWorker(...args) }));
vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent' }, LABEL_AUTO_MERGE: 'ronin:auto-merge', LABEL_MANAGED: 'ronin' }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
const setIssueState = vi.fn();
vi.mock('@platform/github/github.js', () => ({ setIssueState: (...args: unknown[]) => setIssueState(...args) }));
const launchConflictsWorker = vi.fn();
const setAutoMerge = vi.fn();
vi.mock('../commands/index.js', () => ({ launchConflictsWorker: (...args: unknown[]) => launchConflictsWorker(...args), setAutoMerge: (...args: unknown[]) => setAutoMerge(...args) }));
vi.mock('@platform/agents/repo-context.js', () => ({ withActiveRepo: (_entry: unknown, fn: () => unknown) => fn() }));

const { listActions, runAction } = await import('./actions.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const pr = { number: 849, title: '', url: '', author: 'ronin-agent', isDraft: false, headRefName: 'ronin/844/slice-1', baseRefName: 'main', reviewDecision: '' as const, checks: [] };
const gh = (previews: Array<{ prNumber: number; appName: string; url: string; sha: string }> = []) => ({ repo: 'acme/product', fetchedAt: '', blocks: {}, previews, openIssues: [], prIssue: {}, issues: [], prs: [pr] });
const REF = { kind: 'pr' as const, number: 849 };
const DETAIL = { fetchedAt: '', pr: { number: 849, title: '', body: '', author: '', createdAt: '', url: '', state: 'OPEN', labels: [], comments: [] } };

describe.skipIf(!TEST_DATABASE_URL)('a preview asked straight to ronin', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    vi.clearAllMocks();
    launchPreviewWorker.mockReset();
    await db.deleteFrom('commands').execute();
  });

  it('is offered as asked to ronin, not as a comment', () => {
    const actions = listActions(REF, gh([{ prNumber: 849, appName: 'webapp', url: '', sha: 'abc' }]), DETAIL, 'ana-dev');
    expect(actions.filter((a) => a.direct).map((a) => a.id)).toEqual(['resolve-conflicts', 'preview', 'preview-stop', 'auto-merge-on']);
  });

  it('keeps the command and launches its worker with it, writing nothing on GitHub; asked again, gives the first', async () => {
    const post = vi.fn();
    const first = await runAction(ENTRY, REF, gh(), DETAIL, { login: 'ana-dev', token: 't' }, 'preview', 'un cliente con 10 pedidos', post, ['webapp', 'backoffice'], 'webapp');
    expect(post).not.toHaveBeenCalled();
    expect(first).toMatchObject({ existing: false, command: { repo: 'acme/product', number: 849, kind: 'preview', requestedBy: 'ana-dev', status: 'queued', args: { app: 'webapp', text: 'un cliente con 10 pedidos' } } });
    expect(launchPreviewWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 849, action: 'up', args: 'webapp\n\nun cliente con 10 pedidos', command: first.command!.id });
    const again = await runAction(ENTRY, REF, gh(), DETAIL, { login: 'beto-dev', token: 't' }, 'preview', '', post, ['webapp', 'backoffice'], 'backoffice');
    expect(again).toMatchObject({ existing: true, command: { id: first.command!.id, requestedBy: 'ana-dev' } });
    expect(launchPreviewWorker).toHaveBeenCalledTimes(1);
  });

  it('takes a preview down the same way', async () => {
    const done = await runAction(ENTRY, REF, gh([{ prNumber: 849, appName: 'webapp', url: '', sha: 'abc' }]), DETAIL, { login: 'ana-dev', token: 't' }, 'preview-stop', undefined, vi.fn());
    expect(launchPreviewWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 849, action: 'stop', command: done.command!.id });
  });

  // Phase 4 (#446): the rest of the actions, straight to ronin too.
  const SESSION = { login: 'ana-dev', token: 't' };
  const UNMANAGED = { ...gh(), openIssues: [{ number: 901, title: '', url: '', labels: [] }] };
  const BLOCKED = { ...gh(), issues: [{ number: 844, title: '', url: '', status: 'blocked' as const, direct: false, slices: [] }] };

  it('resolves conflicts in its worker, and turns auto-merge on here, answering in the command', async () => {
    const conflicts = await runAction(ENTRY, REF, gh(), DETAIL, SESSION, 'resolve-conflicts', undefined, vi.fn());
    expect(launchConflictsWorker).toHaveBeenCalledWith({ repo: 'acme/product', prNumber: 849, command: conflicts.command!.id });
    setAutoMerge.mockResolvedValueOnce({ reply: '🔀 Auto-merge activado.', refused: false });
    const on = await runAction(ENTRY, REF, gh(), DETAIL, SESSION, 'auto-merge-on', undefined, vi.fn());
    expect(setAutoMerge).toHaveBeenCalledWith(849, 'on');
    expect(on.command).toMatchObject({ kind: 'auto-merge-on', status: 'done', messages: [expect.objectContaining({ text: '🔀 Auto-merge activado.' })] });
  });

  it('unblocks an issue with the answer kept for the agent, and asks for a spike waking the issue commands', async () => {
    const wake = vi.fn(async () => {});
    const post = vi.fn();
    const ISSUE = { kind: 'issue' as const, number: 844 };
    const unblocked = await runAction(ENTRY, ISSUE, BLOCKED, undefined, SESSION, 'unblock', 'Usá la tabla de clientes', post, [], undefined, undefined, undefined, wake);
    expect(post).not.toHaveBeenCalled();
    expect(setIssueState).toHaveBeenCalledWith(844, 'in-progress');
    expect(unblocked.command).toMatchObject({ kind: 'unblock', status: 'done', args: { text: 'Usá la tabla de clientes' } });
    expect(wake).toHaveBeenLastCalledWith('acme/product', ['issue-844'], ['issues']);
    const spike = await runAction(ENTRY, { kind: 'issue', number: 901 }, UNMANAGED, undefined, SESSION, 'spike', 'cómo se calcula el total', post, ['webapp', 'backoffice'], 'webapp', undefined, undefined, wake);
    expect(spike.command).toMatchObject({ kind: 'spike', status: 'queued', args: { app: 'webapp', text: 'cómo se calcula el total' } });
    expect(wake).toHaveBeenLastCalledWith('acme/product', ['issue-901'], ['issue-commands']);
    expect(post).not.toHaveBeenCalled();
  });
});
