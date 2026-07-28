import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

// Exported so callers that need to find an already-created worktree's files
// (e.g. evidence.ts reading Playwright's test-results/ after the fact) can
// derive the same path without duplicating the naming scheme.
export function worktreeDirFor(branch: string): string {
  return join(config.worktreeBasePath, branch.replaceAll('/', '-'));
}

async function branchExists(branch: string): Promise<boolean> {
  return execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: config.productRepoPath })
    .then(() => true)
    .catch(() => false);
}

// Reuses an existing worktree for `branch` if one is already checked out —
// a retried task (fix-review, fix-e2e) picks up where the previous attempt
// left off instead of starting from a clean tree each time.
export async function ensureWorktree(branch: string, baseRef = config.worktreeBaseRef): Promise<string> {
  const dir = worktreeDirFor(branch);
  if (existsSync(dir)) return dir;

  await mkdir(config.worktreeBasePath, { recursive: true });
  const isNewBranch = !(await branchExists(branch));
  if (isNewBranch) {
    // Keeps origin/main current regardless of what's checked out in the
    // primary worktree — a plain `git fetch` never touches the working
    // directory or local branch refs.
    await execFileAsync('git', ['fetch', 'origin'], { cwd: config.productRepoPath }).catch(() => {});
  }
  const args = isNewBranch
    ? ['worktree', 'add', '-b', branch, dir, baseRef]
    : ['worktree', 'add', dir, branch];
  await execFileAsync('git', args, { cwd: config.productRepoPath });
  return dir;
}

// Not called anywhere yet — cleanup timing (on success only? on terminal
// blocked state too?) is tied to the same cross-tick state work tracked in
// tick.ts, so it's exposed here but deliberately unwired for now.
export async function removeWorktree(branch: string): Promise<void> {
  const dir = worktreeDirFor(branch);
  await execFileAsync('git', ['worktree', 'remove', dir, '--force'], { cwd: config.productRepoPath }).catch(() => {});
}
