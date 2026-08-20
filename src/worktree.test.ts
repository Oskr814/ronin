import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestStatus } from './github.js';

// worktreeBaseRef is the only field these tests still read off config —
// productRepoPath/worktreeBasePath now come from activeRepo() (see
// repo-context.ts), set per test via withActiveRepo below.
let mockConfig: Record<string, unknown> = { worktreeBaseRef: 'main' };
vi.mock('./config.js', () => ({ get config() { return mockConfig; } }));

const { isBehind, attemptRebase, branchFromWorktreeDirName, branchesToSweep, ensureWorktree } = await import('./worktree.js');
const { withActiveRepo } = await import('./repo-context.js');

function pr(headRefName: string): PullRequestStatus {
  return {
    number: 1,
    state: 'OPEN',
    reviewDecision: '',
    checksPassing: true,
    checksPending: false,
    mergeable: true,
    headRefName,
    baseRefName: 'main',
    isDraft: false,
  };
}

describe('branchFromWorktreeDirName', () => {
  it('reconstructs a slice branch from its worktree dir name', () => {
    expect(branchFromWorktreeDirName('ronin-228-slice-11')).toBe('ronin/228/slice-11');
  });

  it('reconstructs a plan branch from its worktree dir name', () => {
    expect(branchFromWorktreeDirName('ronin-228-plan')).toBe('ronin/228/plan');
  });

  it('returns null for a dir that is not a ronin worktree', () => {
    expect(branchFromWorktreeDirName('some-other-checkout')).toBeNull();
  });
});

describe('branchesToSweep', () => {
  it('always sweeps a plan worktree, regardless of open PRs', () => {
    expect(branchesToSweep(['ronin-228-plan'], [])).toEqual(['ronin/228/plan']);
  });

  it('keeps a slice worktree whose branch still has an open PR', () => {
    const dirs = ['ronin-228-slice-1'];
    const allPrs = [pr('ronin/228/slice-1')];
    expect(branchesToSweep(dirs, allPrs)).toEqual([]);
  });

  it('sweeps a slice worktree whose branch has no open PR (merged, closed, or blocked)', () => {
    const dirs = ['ronin-228-slice-1', 'ronin-228-slice-2'];
    const allPrs = [pr('ronin/228/slice-2')]; // only slice-2 still open
    expect(branchesToSweep(dirs, allPrs)).toEqual(['ronin/228/slice-1']);
  });

  it('ignores a directory that is not a ronin worktree', () => {
    expect(branchesToSweep(['some-other-checkout'], [])).toEqual([]);
  });
});

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ['init', '-q']);
  await git(cwd, ['config', 'user.email', 'ronin@example.com']);
  await git(cwd, ['config', 'user.name', 'ronin']);
}

// Real git plumbing against local temp repos (a bare "origin" plus a
// worktree-style clone) — no network, no mocking of git itself. This is the
// "real vs. mechanical conflict" coverage that
// docs/superpowers/specs/2026-07-28-stacked-prs-design.md §7 explicitly left
// as a manual dry-run gap, now that fix-rebase is a live, exercised path.
describe('isBehind / attemptRebase — real git rebase behavior', () => {
  let base: string;
  let originDir: string;
  let worktreeDir: string;
  let seed: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-worktree-test-'));
    originDir = join(base, 'origin.git');
    worktreeDir = join(base, 'worktree');
    seed = join(base, 'seed');

    await execFileAsync('git', ['init', '-q', '--bare', originDir]);

    await mkdir(seed, { recursive: true });
    await initRepo(seed);
    await writeFile(join(seed, 'README.md'), 'seed\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'initial']);
    await git(seed, ['branch', '-M', 'main']);
    await git(seed, ['remote', 'add', 'origin', originDir]);
    await git(seed, ['push', '-q', 'origin', 'main']);

    await execFileAsync('git', ['clone', '-q', originDir, worktreeDir]);
    await initRepo(worktreeDir);
    await git(worktreeDir, ['checkout', '-q', '-b', 'feature']);
    await writeFile(join(worktreeDir, 'feature.txt'), 'feature work\n');
    await git(worktreeDir, ['add', '.']);
    await git(worktreeDir, ['commit', '-q', '-m', 'feature commit']);
    await git(worktreeDir, ['push', '-q', '-u', 'origin', 'feature']);

    // Advance main on origin behind the worktree's back, as the real
    // scenario does (a stack's bottom PR merges while a sibling slice's
    // worktree sits untouched) — always via the seed clone, mirroring
    // main only ever moving through a real merge, never edited in-place.
    await writeFile(join(seed, 'other.txt'), 'unrelated change\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'advance main']);
    await git(seed, ['push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('isBehind reports true once origin/main has moved past the worktree', async () => {
    await expect(isBehind(worktreeDir, 'origin/main')).resolves.toBe(true);
  });

  it('mechanically rebases and force-pushes when there is no real conflict', async () => {
    await git(worktreeDir, ['fetch', 'origin']);

    await expect(attemptRebase(worktreeDir, 'origin/main', 'feature')).resolves.toBe(true);

    // Rebase actually landed: feature.txt survives on top of the advanced main.
    const log = await git(worktreeDir, ['log', '--oneline', 'origin/main..HEAD']);
    expect(log).toContain('feature commit');
    await expect(isBehind(worktreeDir, 'origin/main')).resolves.toBe(false);

    // Force-pushed: origin's feature ref matches the rebased local HEAD.
    const originFeature = await git(worktreeDir, ['rev-parse', 'origin/feature']);
    const localHead = await git(worktreeDir, ['rev-parse', 'HEAD']);
    expect(originFeature.trim()).toBe(localHead.trim());
  });

  it('aborts and returns false on a real conflict, leaving the worktree clean', async () => {
    // Make main's advance conflict with the feature branch's own change to
    // the same file (both branches touch feature.txt).
    await writeFile(join(seed, 'feature.txt'), 'main also touched this\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'conflicting main change']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    await git(worktreeDir, ['fetch', 'origin']);

    await expect(attemptRebase(worktreeDir, 'origin/main', 'feature')).resolves.toBe(false);

    // Left in a clean, non-rebasing state — never a half-finished rebase for
    // a later tick (or a human) to trip over.
    const status = await git(worktreeDir, ['status', '--porcelain']);
    expect(status.trim()).toBe('');
    const branch = await git(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch.trim()).toBe('feature');

    // origin/feature was never force-pushed with the (abandoned) rebase.
    const originFeature = await git(worktreeDir, ['rev-parse', 'origin/feature']);
    const localHead = await git(worktreeDir, ['rev-parse', 'HEAD']);
    expect(originFeature.trim()).toBe(localHead.trim());
  });
});

describe('ensureWorktree — per-worktree DB_PORT', () => {
  let base: string;
  let productRepoPath: string;
  let worktreeBasePath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-ensure-worktree-test-'));
    productRepoPath = join(base, 'repo');
    worktreeBasePath = join(base, 'worktrees');
    process.env.WORKTREE_BASE_PATH = worktreeBasePath;

    await mkdir(productRepoPath, { recursive: true });
    await initRepo(productRepoPath);
    await writeFile(join(productRepoPath, 'README.md'), 'seed\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'initial']);
    await git(productRepoPath, ['branch', '-M', 'main']);
  });

  afterEach(async () => {
    delete process.env.WORKTREE_BASE_PATH;
    await rm(base, { recursive: true, force: true });
  });

  function withRepo<T>(fn: () => Promise<T>): Promise<T> {
    return withActiveRepo({ productRepo: 'test/repo', productRepoPath }, fn);
  }

  it('writes a repo-root .env with a real, listening-ready DB_PORT for a freshly created worktree', async () => {
    const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));

    const envContents = await readFile(join(dir, '.env'), 'utf8');
    const match = envContents.match(/^DB_PORT=(\d+)$/m);
    expect(match).not.toBeNull();
    const port = Number(match![1]);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('gives two different worktrees different ports', async () => {
    const dirA = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
    const dirB = await withRepo(() => ensureWorktree('ronin/300/slice-2'));

    const portA = (await readFile(join(dirA, '.env'), 'utf8')).match(/DB_PORT=(\d+)/)![1];
    const portB = (await readFile(join(dirB, '.env'), 'utf8')).match(/DB_PORT=(\d+)/)![1];
    expect(portA).not.toBe(portB);
  });

  it('does not rewrite .env when reusing an already-existing worktree', async () => {
    const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
    const first = await readFile(join(dir, '.env'), 'utf8');

    const reused = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
    const second = await readFile(join(reused, '.env'), 'utf8');

    expect(reused).toBe(dir);
    expect(second).toBe(first);
  });
});
