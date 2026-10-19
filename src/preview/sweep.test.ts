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
const lockHeld = vi.fn();
const launchWorker = vi.fn();
vi.mock('../core/worker-launch.js', () => ({ lockHeld: (...args: unknown[]) => lockHeld(...args), acquireLock: vi.fn(), launchWorker: (...args: unknown[]) => launchWorker(...args) }));
vi.mock('../core/agent-task.js', () => ({ runAgentTask: vi.fn() }));

const { launchPreviewUpdates, sweepPreviews } = await import('./preview.js');

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
  lockHeld.mockResolvedValue(false);
  config.previewTtlMinutes = 60;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('sweepPreviews', () => {
  it('launches the update of a preview that is behind its PR, without a comment of its own', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'bbbbbbb2222' }]);

    await sweepPreviews();

    expect(launchWorker).toHaveBeenCalledWith('preview/worker', { repo: 'acme/product', prNumber: 818, action: 'update' });
    expect(commentOnSpecPr).not.toHaveBeenCalled();
    expect(removeWorktreeDir).not.toHaveBeenCalled();
  });

  it('leaves alone a preview on the PR head, and one whose worker is busy', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111' });
    await writePreview(819, { sha: 'ccccccc3333' });
    listOpenPrHeads.mockResolvedValue([{ number: 818, headRefOid: 'aaaaaaa1111' }, { number: 819, headRefOid: 'ddddddd4444' }]);
    lockHeld.mockImplementation(async (path: string) => path.endsWith('.preview-pr-819.lock'));

    await sweepPreviews();

    expect(launchWorker).not.toHaveBeenCalled();
    expect(commentOnSpecPr).not.toHaveBeenCalled();
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

describe('launchPreviewUpdates', () => {
  it('launches the update of each PR with a preview up and no worker on it', async () => {
    await writePreview(818, { sha: 'aaaaaaa1111' });
    await writePreview(819, { sha: 'ccccccc3333' });
    lockHeld.mockImplementation(async (path: string) => path.endsWith('.preview-pr-819.lock'));

    await launchPreviewUpdates([818, 819, 820]);

    expect(launchWorker).toHaveBeenCalledTimes(1);
    expect(launchWorker).toHaveBeenCalledWith('preview/worker', { repo: 'acme/product', prNumber: 818, action: 'update' });
    expect(listOpenPrHeads).not.toHaveBeenCalled();
  });
});
