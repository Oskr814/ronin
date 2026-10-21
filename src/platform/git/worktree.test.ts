import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestStatus } from '../github/github.js';

// worktreeBaseRef is the only field these tests still read off config —
// productRepoPath/worktreeBasePath now come from activeRepo() (see
// repo-context.ts), set per test via withActiveRepo below.
let mockConfig: Record<string, unknown> = { worktreeBaseRef: 'main' };
vi.mock('../config/config.js', () => ({ get config() { return mockConfig; } }));

const { branchFromWorktreeDirName, branchesToSweep, ensureWorktree, removeWorktree, ensureExternalReviewWorktree, externalReviewWorktreeDirFor, ensureTrustedFixWorktree, removeTrustedFixWorktree, isCommitAvailable, pinReviewedSha, pruneReviewedPins, composeFilesIn } = await import('./worktree.js');
const { withActiveRepo } = await import('../agents/repo-context.js');

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
    body: '',
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

// Root-owned-file cleanup only has real Docker to exercise it against — no
// point failing the whole suite on a box (or CI image) without Docker.
const dockerAvailable = await execFileAsync('docker', ['info']).then(() => true).catch(() => false);

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

  it("uses the active repo's own worktreeBaseRef override instead of config's, when the entry has one", async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'odoo-main']);
    await writeFile(join(productRepoPath, 'ODOO_MARKER.md'), 'only on odoo-main\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'odoo-main only commit']);
    await git(productRepoPath, ['checkout', '-q', 'main']);

    const dir = await withActiveRepo(
      { productRepo: 'test/repo', productRepoPath, worktreeBaseRef: 'odoo-main' },
      () => ensureWorktree('ronin/300/slice-1'),
    );

    await expect(readFile(join(dir, 'ODOO_MARKER.md'), 'utf8')).resolves.toBe('only on odoo-main\n');
  });
});

// Reproduces the live bug: sweepOrphanedWorktrees rediscovering the same
// directory every tick forever because `git worktree remove` categorically
// cannot succeed on it (git's own metadata is already gone — the usual
// cause is a prior removal that unregistered the worktree but couldn't
// finish deleting the directory, e.g. a Docker bind mount still holding a
// file busy), and the old code just logged the identical error and left the
// directory in place for the next sweep to trip over again.
describe('removeWorktree — orphaned directory (git metadata already gone)', () => {
  let base: string;
  let productRepoPath: string;
  let worktreeBasePath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-remove-worktree-test-'));
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

  it('deletes the leftover directory instead of failing forever once git no longer recognizes it as a worktree', async () => {
    const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));

    // Simulate what a prior partial removal leaves behind: git's own
    // worktree registration is gone, but the directory (with real files
    // still in it) survives on disk.
    await git(productRepoPath, ['worktree', 'remove', dir, '--force']);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'leftover.txt'), 'orphaned file\n');
    await expect(git(productRepoPath, ['worktree', 'list'])).resolves.not.toContain(dir);

    await expect(withRepo(() => removeWorktree('ronin/300/slice-1'))).resolves.toBeUndefined();

    await expect(readFile(join(dir, 'leftover.txt'), 'utf8')).rejects.toThrow();
  });

  it('is a no-op when the directory never existed at all', async () => {
    await expect(withRepo(() => removeWorktree('ronin/300/never-created'))).resolves.toBeUndefined();
  });

  // Reproduces external-pr-614: `git worktree remove` was never run before
  // by anyone, but it deletes its own admin entry *before* the working
  // tree, so a permission failure on the second step ("failed to delete
  // '<dir>': Permission denied", root-owned Docker build output) leaves an
  // unregistered directory behind while its stderr does NOT say "is not a
  // working tree". The old fallback matched only that string and looped
  // forever.
  it.skipIf(!dockerAvailable)(
    'cleans up when git worktree remove fails on the delete step (never pre-unregistered)',
    async () => {
      const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
      await execFileAsync('docker', ['run', '--rm', '-v', `${dir}:/target`, 'busybox', 'sh', '-c', 'mkdir -p /target/obj && touch /target/obj/build.o']);

      await expect(withRepo(() => removeWorktree('ronin/300/slice-1'))).resolves.toBeUndefined();

      expect(existsSync(dir)).toBe(false);
    },
    30_000,
  );

  // Reproduces the follow-up live failure: a Docker container writes files
  // as root inside a bind-mounted worktree (a build's obj/bin output, a
  // Postgres data/init dir — this is the actual reason a prior
  // `git worktree remove` couldn't finish deleting the directory in the
  // first place), so the unprivileged `rm -rf` fallback above also hits
  // EACCES on rmdir and gives up in exactly the same "fails forever" way.
  it.skipIf(!dockerAvailable)(
    'removes a root-owned leftover (created by a Docker container) that plain rm -rf cannot touch',
    async () => {
      const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
      await git(productRepoPath, ['worktree', 'remove', dir, '--force']);
      await mkdir(dir, { recursive: true });

      // Root inside the container == root on the host for a bind mount.
      await execFileAsync('docker', ['run', '--rm', '-v', `${dir}:/target`, 'busybox', 'sh', '-c', 'mkdir -p /target/Dumps/postgres && touch /target/Dumps/postgres/data']);
      await expect(readFile(join(dir, 'Dumps/postgres/data'), 'utf8')).resolves.toBe('');

      await expect(withRepo(() => removeWorktree('ronin/300/slice-1'))).resolves.toBeUndefined();

      expect(existsSync(dir)).toBe(false);
    },
    30_000,
  );
});

// Real git plumbing, no mocks: the three scenarios final review Fix 1 calls
// out — a re-review of the same PR after new commits, a fork PR whose head
// branch does not exist in this repo, and a fork PR whose head branch is
// named `main` (already checked out in the primary worktree, which is what
// made the old branch-name-based path throw forever).
describe('ensureExternalReviewWorktree — checkout by SHA', () => {
  let base: string;
  let originDir: string;
  let productRepoPath: string;
  let worktreeBasePath: string;
  let forkWork: string;

  async function pushPrHead(prNumber: number, branchName: string, content: string): Promise<string> {
    await writeFile(join(forkWork, 'contributed.txt'), content);
    await git(forkWork, ['add', '.']);
    await git(forkWork, ['commit', '-q', '-m', `contribution: ${content.trim()}`]);
    const sha = (await git(forkWork, ['rev-parse', 'HEAD'])).trim();
    // Exactly how GitHub exposes a PR head on the base repo, fork or not.
    await git(forkWork, ['push', '-q', '-f', 'origin', `HEAD:refs/pull/${prNumber}/head`]);
    // …and, for the collision scenarios, also as a real branch name.
    if (branchName) await git(forkWork, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${branchName}`]);
    return sha;
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-external-worktree-test-'));
    originDir = join(base, 'origin.git');
    productRepoPath = join(base, 'repo');
    worktreeBasePath = join(base, 'worktrees');
    forkWork = join(base, 'fork');
    process.env.WORKTREE_BASE_PATH = worktreeBasePath;

    await execFileAsync('git', ['init', '-q', '--bare', originDir]);

    const seed = join(base, 'seed');
    await mkdir(seed, { recursive: true });
    await initRepo(seed);
    await writeFile(join(seed, 'README.md'), 'seed\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'initial']);
    await git(seed, ['branch', '-M', 'main']);
    await git(seed, ['remote', 'add', 'origin', originDir]);
    await git(seed, ['push', '-q', 'origin', 'main']);

    await execFileAsync('git', ['clone', '-q', originDir, productRepoPath]);
    await initRepo(productRepoPath);
    await execFileAsync('git', ['clone', '-q', originDir, forkWork]);
    await initRepo(forkWork);
  });

  afterEach(async () => {
    delete process.env.WORKTREE_BASE_PATH;
    await rm(base, { recursive: true, force: true });
  });

  function withRepo<T>(fn: () => Promise<T>): Promise<T> {
    return withActiveRepo({ productRepo: 'test/repo', productRepoPath }, fn);
  }

  it('checks out the exact PR head even when its branch name does not exist in this repo', async () => {
    const sha = await pushPrHead(305, '', 'fork work\n');

    const dir = await withRepo(() => ensureExternalReviewWorktree(305, sha));

    expect(dir).toBe(join(worktreeBasePath, 'external-pr-305'));
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    expect(await readFile(join(dir, 'contributed.txt'), 'utf8')).toBe('fork work\n');
  });

  it('resyncs an already-existing worktree to the PR\'s new head instead of reusing stale code', async () => {
    const firstSha = await pushPrHead(305, '', 'first pass\n');
    await withRepo(() => ensureExternalReviewWorktree(305, firstSha));

    const secondSha = await pushPrHead(305, '', 'second pass\n');
    const dir = await withRepo(() => ensureExternalReviewWorktree(305, secondSha));

    expect(secondSha).not.toBe(firstSha);
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(secondSha);
    expect(await readFile(join(dir, 'contributed.txt'), 'utf8')).toBe('second pass\n');
  });

  it('rebuilds the worktree when a previous run left a non-git directory behind', async () => {
    const firstSha = await pushPrHead(305, '', 'first pass\n');
    const dir = await withRepo(() => ensureExternalReviewWorktree(305, firstSha));

    // What external-pr-614's failed cleanup left on disk: git no longer
    // registers the worktree and the .git link is gone, but the directory
    // (with files) survives — here a plain dir stands in for the
    // root-owned Docker leftovers that blocked the delete.
    await git(productRepoPath, ['worktree', 'remove', dir, '--force']);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stale.txt'), 'left over\n');

    const secondSha = await pushPrHead(305, '', 'second pass\n');
    const out = await withRepo(() => ensureExternalReviewWorktree(305, secondSha));

    expect(out).toBe(dir);
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(secondSha);
    expect(await readFile(join(dir, 'contributed.txt'), 'utf8')).toBe('second pass\n');
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
  });

  it('works for a PR whose head branch is named `main`, already checked out in the primary worktree', async () => {
    const sha = await pushPrHead(305, 'main', 'fork main work\n');

    const dir = await withRepo(() => ensureExternalReviewWorktree(305, sha));

    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    // Detached: no local branch was created or moved for this checkout.
    const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.trim()).toBe('HEAD');
  });
});

// Real git plumbing, no mocks: reproduces PR #336 live — a trusted human's
// /fix-comments target branch checked out in the primary worktree at the
// same time ronin tries to work on it.
describe('ensureTrustedFixWorktree — checkout by branch name, detached', () => {
  let base: string;
  let originDir: string;
  let productRepoPath: string;
  let worktreeBasePath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-trusted-fix-worktree-test-'));
    originDir = join(base, 'origin.git');
    productRepoPath = join(base, 'repo');
    worktreeBasePath = join(base, 'worktrees');
    process.env.WORKTREE_BASE_PATH = worktreeBasePath;

    await execFileAsync('git', ['init', '-q', '--bare', originDir]);

    const seed = join(base, 'seed');
    await mkdir(seed, { recursive: true });
    await initRepo(seed);
    await writeFile(join(seed, 'README.md'), 'seed\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'initial']);
    await git(seed, ['branch', '-M', 'main']);
    await git(seed, ['remote', 'add', 'origin', originDir]);
    await git(seed, ['push', '-q', 'origin', 'main']);

    await execFileAsync('git', ['clone', '-q', originDir, productRepoPath]);
    await initRepo(productRepoPath);
  });

  afterEach(async () => {
    delete process.env.WORKTREE_BASE_PATH;
    await rm(base, { recursive: true, force: true });
  });

  function withRepo<T>(fn: () => Promise<T>): Promise<T> {
    return withActiveRepo({ productRepo: 'test/repo', productRepoPath }, fn);
  }

  it('succeeds even when the branch is already checked out in the primary worktree', async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'feat/prescription-frequency-input']);
    await writeFile(join(productRepoPath, 'contributed.txt'), 'human work\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'human commit']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/prescription-frequency-input']);
    const sha = (await git(productRepoPath, ['rev-parse', 'HEAD'])).trim();

    const dir = await withRepo(() => ensureTrustedFixWorktree('feat/prescription-frequency-input'));

    expect(dir).toBe(join(worktreeBasePath, 'feat-prescription-frequency-input'));
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    expect(await readFile(join(dir, 'contributed.txt'), 'utf8')).toBe('human work\n');
    // Detached: no local branch was created or moved for this checkout.
    const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.trim()).toBe('HEAD');
  });

  it("resyncs an already-existing worktree to the branch's new head instead of reusing stale code", async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'feat/x']);
    await writeFile(join(productRepoPath, 'file.txt'), 'first pass\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'first']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/x']);
    await withRepo(() => ensureTrustedFixWorktree('feat/x'));

    await writeFile(join(productRepoPath, 'file.txt'), 'second pass\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'second']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/x']);
    const secondSha = (await git(productRepoPath, ['rev-parse', 'HEAD'])).trim();

    const dir = await withRepo(() => ensureTrustedFixWorktree('feat/x'));

    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(secondSha);
    expect(await readFile(join(dir, 'file.txt'), 'utf8')).toBe('second pass\n');
  });

  it('rebuilds the worktree when a previous run left a non-git directory behind', async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'feat/y']);
    await writeFile(join(productRepoPath, 'file.txt'), 'first pass\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'first']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/y']);
    const dir = await withRepo(() => ensureTrustedFixWorktree('feat/y'));

    await git(productRepoPath, ['worktree', 'remove', dir, '--force']);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stale.txt'), 'left over\n');

    await writeFile(join(productRepoPath, 'file.txt'), 'second pass\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'second']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/y']);
    const secondSha = (await git(productRepoPath, ['rev-parse', 'HEAD'])).trim();

    const out = await withRepo(() => ensureTrustedFixWorktree('feat/y'));

    expect(out).toBe(dir);
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(secondSha);
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
  });

  it('writes a repo-root .env with a real DB_PORT, like ensureWorktree', async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'feat/z']);
    await writeFile(join(productRepoPath, 'file.txt'), 'content\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'commit']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/z']);

    const dir = await withRepo(() => ensureTrustedFixWorktree('feat/z'));

    const envContents = await readFile(join(dir, '.env'), 'utf8');
    const match = envContents.match(/^DB_PORT=(\d+)$/m);
    expect(match).not.toBeNull();
  });
});

describe('removeTrustedFixWorktree', () => {
  let base: string;
  let originDir: string;
  let productRepoPath: string;
  let worktreeBasePath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ronin-remove-trusted-fix-worktree-test-'));
    originDir = join(base, 'origin.git');
    productRepoPath = join(base, 'repo');
    worktreeBasePath = join(base, 'worktrees');
    process.env.WORKTREE_BASE_PATH = worktreeBasePath;

    await execFileAsync('git', ['init', '-q', '--bare', originDir]);
    const seed = join(base, 'seed');
    await mkdir(seed, { recursive: true });
    await initRepo(seed);
    await writeFile(join(seed, 'README.md'), 'seed\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'initial']);
    await git(seed, ['branch', '-M', 'main']);
    await git(seed, ['remote', 'add', 'origin', originDir]);
    await git(seed, ['push', '-q', 'origin', 'main']);
    await execFileAsync('git', ['clone', '-q', originDir, productRepoPath]);
    await initRepo(productRepoPath);
  });

  afterEach(async () => {
    delete process.env.WORKTREE_BASE_PATH;
    await rm(base, { recursive: true, force: true });
  });

  function withRepo<T>(fn: () => Promise<T>): Promise<T> {
    return withActiveRepo({ productRepo: 'test/repo', productRepoPath }, fn);
  }

  it('removes the worktree created by ensureTrustedFixWorktree', async () => {
    await git(productRepoPath, ['checkout', '-q', '-b', 'feat/w']);
    await writeFile(join(productRepoPath, 'file.txt'), 'content\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'commit']);
    await git(productRepoPath, ['push', '-q', 'origin', 'feat/w']);
    const dir = await withRepo(() => ensureTrustedFixWorktree('feat/w'));

    await withRepo(() => removeTrustedFixWorktree('feat/w'));

    expect(existsSync(dir)).toBe(false);
  });

  it('is a no-op when the directory never existed at all', async () => {
    await expect(withRepo(() => removeTrustedFixWorktree('feat/never-created'))).resolves.toBeUndefined();
  });
});

describe('externalReviewWorktreeDirFor', () => {
  it('names the directory by PR number, never by branch name', async () => {
    process.env.WORKTREE_BASE_PATH = '/tmp/worktrees';
    const dir = await withActiveRepo({ productRepo: 'test/repo', productRepoPath: '/tmp/repo' }, async () =>
      externalReviewWorktreeDirFor(305),
    );
    delete process.env.WORKTREE_BASE_PATH;

    expect(dir).toBe('/tmp/worktrees/external-pr-305');
  });
});

describe('reviewed-SHA pins — real git', () => {
  let repo: string;
  let first: string;

  async function commit(content: string): Promise<string> {
    await writeFile(join(repo, 'f.txt'), content);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', content]);
    return (await git(repo, ['rev-parse', 'HEAD'])).trim();
  }

  const inRepo = <T>(fn: () => Promise<T>) => withActiveRepo({ productRepo: 'test/repo', productRepoPath: repo }, fn);

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ronin-pin-test-'));
    await initRepo(repo);
    first = await commit('one\n');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('keeps an amended-away commit reachable, and prunes the pins of closed PRs only', async () => {
    await inRepo(async () => {
      await pinReviewedSha(7, first);
      await pinReviewedSha(8, first);
      // The amend leaves `first` unreachable from any branch.
      await writeFile(join(repo, 'f.txt'), 'amended\n');
      await git(repo, ['commit', '-q', '-a', '--amend', '-m', 'amended']);
      await git(repo, ['reflog', 'expire', '--expire=now', '--all']);
      await git(repo, ['gc', '-q', '--prune=now']);

      expect(await isCommitAvailable(first)).toBe(true);

      await pruneReviewedPins([7]);
      const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/ronin/reviewed/'])).trim();
      expect(refs).toBe('refs/ronin/reviewed/7');
    });
  });

  it('reports a commit the repo does not have as unavailable', async () => {
    await inRepo(async () => {
      expect(await isCommitAvailable('0123456789abcdef0123456789abcdef01234567')).toBe(false);
    });
  });
});

describe('composeFilesIn', () => {
  it('finds every compose file at the worktree root, not only the default one', () => {
    expect(
      composeFilesIn(['docker-compose.dev.yml', 'README.md', 'compose.yaml', 'docker-compose.yml', 'docker-compose.override.yaml', 'mycompose.yml', 'Dockerfile']),
    ).toEqual(['compose.yaml', 'docker-compose.dev.yml', 'docker-compose.override.yaml', 'docker-compose.yml']);
  });

  it('finds nothing in a repo without Docker', () => {
    expect(composeFilesIn(['package.json', 'src'])).toEqual([]);
  });
});
