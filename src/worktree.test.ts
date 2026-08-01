import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestStatus } from './github.js';

vi.mock('./config.js', () => ({ config: {} }));

const { isBehind, attemptRebase, branchFromWorktreeDirName, branchesToSweep } = await import('./worktree.js');

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
    expect(branchFromWorktreeDirName('valeria-228-slice-11')).toBe('valeria/228/slice-11');
  });

  it('reconstructs a plan branch from its worktree dir name', () => {
    expect(branchFromWorktreeDirName('valeria-228-plan')).toBe('valeria/228/plan');
  });

  it('returns null for a dir that is not a ValerIA worktree', () => {
    expect(branchFromWorktreeDirName('some-other-checkout')).toBeNull();
  });
});

describe('branchesToSweep', () => {
  it('always sweeps a plan worktree, regardless of open PRs', () => {
    expect(branchesToSweep(['valeria-228-plan'], [])).toEqual(['valeria/228/plan']);
  });

  it('keeps a slice worktree whose branch still has an open PR', () => {
    const dirs = ['valeria-228-slice-1'];
    const allPrs = [pr('valeria/228/slice-1')];
    expect(branchesToSweep(dirs, allPrs)).toEqual([]);
  });

  it('sweeps a slice worktree whose branch has no open PR (merged, closed, or blocked)', () => {
    const dirs = ['valeria-228-slice-1', 'valeria-228-slice-2'];
    const allPrs = [pr('valeria/228/slice-2')]; // only slice-2 still open
    expect(branchesToSweep(dirs, allPrs)).toEqual(['valeria/228/slice-1']);
  });

  it('ignores a directory that is not a ValerIA worktree', () => {
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
  await git(cwd, ['config', 'user.email', 'valeria@example.com']);
  await git(cwd, ['config', 'user.name', 'ValerIA']);
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
    base = await mkdtemp(join(tmpdir(), 'valeria-worktree-test-'));
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
