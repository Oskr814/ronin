import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';

// A preview asked from the tablero (#446): kept as a command and its worker
// launched with it, without a word on GitHub.
const launchPreviewWorker = vi.fn();
vi.mock('../previews/index.js', () => ({ launchPreviewWorker: (...args: unknown[]) => launchPreviewWorker(...args) }));
vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent' }, LABEL_AUTO_MERGE: 'ronin:auto-merge', LABEL_MANAGED: 'ronin' }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@platform/github/github.js', () => ({ setIssueState: vi.fn() }));
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
    launchPreviewWorker.mockReset();
    await db.deleteFrom('commands').execute();
  });

  it('is offered as asked to ronin, not as a comment', () => {
    const actions = listActions(REF, gh([{ prNumber: 849, appName: 'webapp', url: '', sha: 'abc' }]), DETAIL, 'ana-dev');
    expect(actions.filter((a) => a.direct).map((a) => a.id)).toEqual(['preview', 'preview-stop']);
    expect(actions.find((a) => a.id === 'auto-merge-on')).not.toHaveProperty('direct');
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
});
