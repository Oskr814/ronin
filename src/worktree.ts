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

// Authoritative check against the remote itself (never depends on a prior
// `git fetch` having updated local remote-tracking refs) — used to tell
// "branch exists only on origin (e.g. created by a different machine/runner)"
// apart from "branch genuinely doesn't exist anywhere yet". Exported so
// agent-task.ts can make the same check before using a computed base branch
// (see final review Fix 3).
export async function remoteBranchExists(branch: string): Promise<boolean> {
  return execFileAsync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: config.productRepoPath })
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
  const local = await branchExists(branch);
  // Only relevant when there's no local ref yet — ls-remote before any fetch
  // so this doesn't depend on local remote-tracking refs being fresh.
  const remote = local ? false : await remoteBranchExists(branch);
  if (!local) {
    // Keeps origin/main current regardless of what's checked out in the
    // primary worktree — a plain `git fetch` never touches the working
    // directory or local branch refs. Also materializes origin/<branch>
    // locally so the remote-branch case below can reference it.
    await execFileAsync('git', ['fetch', 'origin'], { cwd: config.productRepoPath }).catch(() => {});
  }
  // Local branch: reuse it as-is. No local ref but it exists on origin
  // (e.g. a different machine/runner created it): check it out tracking the
  // remote branch — never fabricate a brand-new empty branch of the same
  // name in this case, since a later force-push could then clobber the real
  // remote branch's content (reproduced during this plan's Task 10 fix
  // rounds). Only truly new (branch exists nowhere): create from baseRef.
  const args = local
    ? ['worktree', 'add', dir, branch]
    : remote
      ? ['worktree', 'add', '-b', branch, dir, `origin/${branch}`]
      : ['worktree', 'add', '-b', branch, dir, baseRef];
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

export async function isBehind(worktreeDir: string, ontoBranch: string): Promise<boolean> {
  await execFileAsync('git', ['fetch', 'origin'], { cwd: worktreeDir });
  return execFileAsync('git', ['merge-base', '--is-ancestor', ontoBranch, 'HEAD'], { cwd: worktreeDir })
    .then(() => false)
    .catch(() => true);
}

// Best-effort: usado solo para el fondo del stack, después de que su
// predecesor mergea (ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md
// §5). Un conflicto real es un resultado esperado a veces — el caller cae a
// una tarea de agente fix-rebase cuando esto devuelve false, nunca propaga el
// error crudo de git.
//
// `branch` is required (not inferred) because a bare `git push
// --force-with-lease` has no reliable default upstream in either
// branch-creation path: slice 0's branch gets its upstream auto-set to
// origin/main (name mismatch under push.default=simple), and slice N>0's
// branch (created from a local branch) gets no upstream at all. Explicit
// refspec sidesteps both. See final review Fix 4.
export async function attemptRebase(worktreeDir: string, ontoBranch: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rebase', ontoBranch], { cwd: worktreeDir });
  } catch {
    await execFileAsync('git', ['rebase', '--abort'], { cwd: worktreeDir }).catch(() => {});
    return false;
  }
  try {
    await execFileAsync('git', ['push', '--force-with-lease', 'origin', `${branch}:${branch}`], { cwd: worktreeDir });
  } catch {
    return false;
  }
  return true;
}
