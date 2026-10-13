import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

let base: string;
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent', previewReservationsDir: '/nonexistent' } }));
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product', productRepoPath: '/repo', worktreeBasePath: base }) }));

const listOpenPrHeads = vi.fn();
const commentOnSpecPr = vi.fn();
vi.mock('./github.js', () => ({
  listOpenPrHeads: (...args: unknown[]) => listOpenPrHeads(...args),
  commentOnSpecPr: (...args: unknown[]) => commentOnSpecPr(...args),
}));
vi.mock('./app-runtime.js', () => ({ appDown: vi.fn(), appUp: vi.fn(), APP_STATE_DIR: '.ronin-app' }));
const removeWorktreeDir = vi.fn();
vi.mock('./worktree.js', () => ({ removeWorktreeDir: (...args: unknown[]) => removeWorktreeDir(...args) }));
vi.mock('./worker-launch.js', () => ({ lockHeld: vi.fn().mockResolvedValue(false), acquireLock: vi.fn(), launchWorker: vi.fn() }));
vi.mock('./agent-task.js', () => ({ runAgentTask: vi.fn() }));

const { sweepPreviews } = await import('./preview.js');

async function writePreview(pr: number, state: object): Promise<string> {
  const dir = join(base, `preview-pr-${pr}`, '.ronin-app');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'preview.json'), JSON.stringify({ prNumber: pr, appName: 'backoffice', url: 'https://h:20001', published: [], ...state }));
  return join(dir, 'preview.json');
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'preview-sweep-'));
  vi.clearAllMocks();
  commentOnSpecPr.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('sweepPreviews', () => {
  it('tells the PR once that its preview is behind new commits', async () => {
    const statePath = await writePreview(818, { sha: 'aaaaaaa1111' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'bbbbbbb2222' }]);

    await sweepPreviews();
    await sweepPreviews();

    expect(commentOnSpecPr).toHaveBeenCalledTimes(1);
    expect(commentOnSpecPr).toHaveBeenCalledWith(818, expect.stringContaining('sigue en `aaaaaaa`'));
    expect(commentOnSpecPr.mock.calls[0][1]).toContain('`@ronin-agent /preview`');
    expect(JSON.parse(await readFile(statePath, 'utf8')).staleNotified).toBe(true);
    expect(removeWorktreeDir).not.toHaveBeenCalled();
  });

  it('says nothing while the preview is on the PR head', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'aaaaaaa1111' }]);

    await sweepPreviews();

    expect(commentOnSpecPr).not.toHaveBeenCalled();
  });

  it('tries again next tick when the notice could not be posted', async () => {
    const statePath = await writePreview(818, { sha: 'aaaaaaa1111' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'bbbbbbb2222' }]);
    commentOnSpecPr.mockRejectedValueOnce(new Error('gh down'));

    await sweepPreviews();

    expect(JSON.parse(await readFile(statePath, 'utf8')).staleNotified).toBeUndefined();
  });

  it('takes down the preview of a PR that is no longer open, without a notice', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111' });
    listOpenPrHeads.mockResolvedValue([]);

    await sweepPreviews();

    expect(commentOnSpecPr).not.toHaveBeenCalled();
    expect(removeWorktreeDir).toHaveBeenCalledWith(join(base, 'preview-pr-818'), 'stopPreview');
  });
});
