import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

let base: string;
const config = { githubLogin: 'ronin-agent', previewReservationsDir: '/nonexistent', previewTtlMinutes: 60 };
vi.mock('../core/config.js', () => ({ config }));
vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product', productRepoPath: '/repo', worktreeBasePath: base }) }));

const listOpenPrHeads = vi.fn();
const commentOnSpecPr = vi.fn();
vi.mock('../core/github.js', () => ({
  listOpenPrHeads: (...args: unknown[]) => listOpenPrHeads(...args),
  commentOnSpecPr: (...args: unknown[]) => commentOnSpecPr(...args),
}));
vi.mock('../app/runtime.js', () => ({ appDown: vi.fn(), appUp: vi.fn(), APP_STATE_DIR: '.ronin-app' }));
const removeWorktreeDir = vi.fn();
vi.mock('../core/worktree.js', () => ({ removeWorktreeDir: (...args: unknown[]) => removeWorktreeDir(...args) }));
vi.mock('../core/worker-launch.js', () => ({ lockHeld: vi.fn().mockResolvedValue(false), acquireLock: vi.fn(), launchWorker: vi.fn() }));
vi.mock('../core/agent-task.js', () => ({ runAgentTask: vi.fn() }));

const { sweepPreviews } = await import('./preview.js');

async function writePreview(pr: number, state: object): Promise<string> {
  const dir = join(base, `preview-pr-${pr}`, '.ronin-app');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'preview.json'), JSON.stringify({ prNumber: pr, appName: 'backoffice', url: 'https://h:20001', published: [], startedAt: new Date().toISOString(), ...state }));
  return join(dir, 'preview.json');
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'preview-sweep-'));
  vi.clearAllMocks();
  commentOnSpecPr.mockResolvedValue(undefined);
  config.previewTtlMinutes = 60;
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

  it('takes down a preview that has been up past its TTL and tells the PR', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111', startedAt: '2026-10-14T10:00:00.000Z' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'bbbbbbb2222' }]);

    await sweepPreviews(new Date('2026-10-14T11:00:00.000Z'));

    expect(removeWorktreeDir).toHaveBeenCalledWith(join(base, 'preview-pr-818'), 'stopPreview');
    expect(commentOnSpecPr).toHaveBeenCalledTimes(1);
    expect(commentOnSpecPr).toHaveBeenCalledWith(818, expect.stringContaining('llevaba 1 hora arriba'));
    expect(commentOnSpecPr.mock.calls[0][1]).toContain('`@ronin-agent /preview`');
  });

  it('leaves a preview alone before its TTL', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111', startedAt: '2026-10-14T10:00:00.000Z' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'aaaaaaa1111' }]);

    await sweepPreviews(new Date('2026-10-14T10:59:00.000Z'));

    expect(removeWorktreeDir).not.toHaveBeenCalled();
    expect(commentOnSpecPr).not.toHaveBeenCalled();
  });

  it('starts the count for a preview from before the TTL instead of taking it down', async () => {
    const statePath = await writePreview(818, { sha: 'aaaaaaa1111', startedAt: undefined });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'aaaaaaa1111' }]);

    await sweepPreviews(new Date('2026-10-14T10:00:00.000Z'));

    expect(removeWorktreeDir).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, 'utf8')).startedAt).toBe('2026-10-14T10:00:00.000Z');
  });

  it('never expires with PREVIEW_TTL_MINUTES=0', async () => {
    config.previewTtlMinutes = 0;
    await writePreview(818, { sha: 'aaaaaaa1111', startedAt: '2020-01-01T00:00:00.000Z' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'aaaaaaa1111' }]);

    await sweepPreviews();

    expect(removeWorktreeDir).not.toHaveBeenCalled();
  });
});
