import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
import type { PullRequestStatus } from './github.js';

const execFileAsync = promisify(execFile);

// Asks the OS for a free ephemeral port (bind to 0, read back what it
// assigned, release it) instead of guessing one — same trick most dev
// tooling uses to sidestep a fixed-port collision. There's a small window
// between releasing it here and whatever eventually binds it (e.g. the
// agent's own `docker compose up -d`, which can run much later in a long
// task) where another process could grab the same port first; acceptable
// given the alternative was a guaranteed collision on a literal :5432.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => (port !== null ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

// Exported so callers that need to find an already-created worktree's files
// can derive the same path without duplicating the naming scheme.
export function worktreeDirFor(branch: string): string {
  return join(activeRepo().worktreeBasePath, branch.replaceAll('/', '-'));
}

async function branchExists(branch: string): Promise<boolean> {
  return execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: activeRepo().productRepoPath })
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
  return execFileAsync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: activeRepo().productRepoPath })
    .then(() => true)
    .catch(() => false);
}

// Reuses an existing worktree for `branch` if one is already checked out —
// a retried task (fix-review, fix-e2e) picks up where the previous attempt
// left off instead of starting from a clean tree each time.
export async function ensureWorktree(branch: string, baseRef = activeRepo().worktreeBaseRef ?? config.worktreeBaseRef): Promise<string> {
  const dir = worktreeDirFor(branch);
  if (existsSync(dir)) return dir;

  await mkdir(activeRepo().worktreeBasePath, { recursive: true });
  const local = await branchExists(branch);
  // Only relevant when there's no local ref yet — ls-remote before any fetch
  // so this doesn't depend on local remote-tracking refs being fresh.
  const remote = local ? false : await remoteBranchExists(branch);
  if (!local) {
    // Keeps origin/main current regardless of what's checked out in the
    // primary worktree — a plain `git fetch` never touches the working
    // directory or local branch refs. Also materializes origin/<branch>
    // locally so the remote-branch case below can reference it.
    await execFileAsync('git', ['fetch', 'origin'], { cwd: activeRepo().productRepoPath }).catch(() => {});
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
  await execFileAsync('git', args, { cwd: activeRepo().productRepoPath });

  // A repo-root .env, auto-loaded by `docker compose` (see bmedical's own
  // docker-compose.yml, which reads DB_PORT from here) — gives this
  // worktree's Postgres stack its own host port instead of the fixed 5432
  // default, so it never collides with another worktree's stack (or a
  // human's own manual `docker compose up`) running at the same time. Only
  // Postgres actually needs this, but ensureWorktree doesn't know which
  // task type it's building for, and writing an unused .env is harmless.
  const port = await getFreePort();
  await writeFile(join(dir, '.env'), `DB_PORT=${port}\n`);

  return dir;
}

// bmedical's own docker-compose.yml (a per-slice Postgres used by
// integration tests) has no project `name:` set, so Compose defaults the
// project name to the cwd's basename — which for a worktree is exactly this
// dir's own name (see worktreeDirFor), giving every slice's worktree its own
// isolated stack. Nothing ever tore these down: discovered live as
// `ronin-228-slice-9-postgres-1` and `ronin-228-slice-10-postgres-1`
// still running (one still "Up 12 hours (healthy)") long after their PRs
// had merged. Best-effort — a worktree that never touched Docker has no
// compose project to tear down, and `docker compose down` against a missing
// config/no running project just errors harmlessly.
async function removeDockerStack(worktreeDir: string): Promise<void> {
  await execFileAsync('docker', ['compose', 'down', '--volumes', '--remove-orphans'], { cwd: worktreeDir })
    .catch((error) => log.error(`removeDockerStack: 'docker compose down' falló en ${worktreeDir}, stack puede haber quedado corriendo`, error));
}

// Called at merge time (tick.ts's processSlicePr), right after a 'plan' task
// finishes (tick.ts's discoverAssignedSpecs — that branch never opens a PR,
// so the merge-time call above never reaches it), and from
// sweepOrphanedWorktrees below for anything either of those missed. Never
// throws — every caller treats this as best-effort, but failures are logged
// now instead of silently swallowed, so a repeat miss (like the one
// discovered live: PR #239's worktree survived days after merging) is
// visible in the tick log instead of invisible.
export async function removeWorktree(branch: string): Promise<void> {
  const dir = worktreeDirFor(branch);
  await removeDockerStack(dir);
  await execFileAsync('git', ['worktree', 'remove', dir, '--force'], { cwd: activeRepo().productRepoPath })
    .catch((error) => log.error(`removeWorktree: 'git worktree remove' falló para ${dir}`, error));
}

// External PRs are reviewed by commit SHA, not by branch name: a fork's head
// branch can collide with any local ref (including ronin's own in-flight
// branches, or the primary worktree's own checked-out `main`), and a
// re-review must always see the PR's *current* head, not whatever was
// checked out for a previous review of the same PR — see final review Fix 1,
// docs/superpowers/specs/2026-08-20-external-pr-review-design.md.
export function externalReviewWorktreeDirFor(prNumber: number): string {
  return join(activeRepo().worktreeBasePath, `external-pr-${prNumber}`);
}

// Unlike ensureWorktree, this ALWAYS resyncs to headSha even when the
// directory already exists — a stale reuse here is exactly the bug this
// function exists to prevent.
export async function ensureExternalReviewWorktree(prNumber: number, headSha: string): Promise<string> {
  const dir = externalReviewWorktreeDirFor(prNumber);
  // GitHub exposes every PR's head under refs/pull/<n>/head on the BASE
  // repo regardless of which fork it lives on — this is what makes fork
  // PRs reachable at all without adding the fork as a remote.
  await execFileAsync('git', ['fetch', 'origin', `pull/${prNumber}/head`], { cwd: activeRepo().productRepoPath });

  if (!existsSync(dir)) {
    await mkdir(activeRepo().worktreeBasePath, { recursive: true });
    await execFileAsync('git', ['worktree', 'add', '--detach', dir, headSha], { cwd: activeRepo().productRepoPath });
  } else {
    await execFileAsync('git', ['checkout', '--detach', headSha], { cwd: dir });
  }
  return dir;
}

// Counterpart cleanup — called after every external-review run (success or
// failure) so these never accumulate the way final review Fix 3 describes.
export async function removeExternalReviewWorktree(prNumber: number): Promise<void> {
  const dir = externalReviewWorktreeDirFor(prNumber);
  await removeDockerStack(dir);
  await execFileAsync('git', ['worktree', 'remove', dir, '--force'], { cwd: activeRepo().productRepoPath })
    .catch((error) => log.error(`removeExternalReviewWorktree: 'git worktree remove' falló para ${dir}`, error));
}

const WORKTREE_DIR_RE = /^ronin-(\d+)-(.+)$/;

// Reconstructs the branch name from a worktree directory name — the exact
// inverse of worktreeDirFor's `branch.replaceAll('/', '-')`. Safe because
// every ronin branch has exactly this shape (ronin/<issue>/<rest>, issue
// always numeric — see stack.ts's sliceBranch/planBranch), so there's no
// ambiguity to resolve. Exported for direct unit testing.
export function branchFromWorktreeDirName(name: string): string | null {
  const match = name.match(WORKTREE_DIR_RE);
  return match ? `ronin/${match[1]}/${match[2]}` : null;
}

// Pure decision logic behind sweepOrphanedWorktrees below, split out so it's
// testable without real git/Docker: which branches, out of a list of
// worktree directory names, no longer earn their place on disk. Two cases —
// a 'plan' worktree (never opens a PR, so it never earns removal any other
// way — see agent-task.ts) always goes; a slice worktree goes once its
// branch no longer has an open PR (covers a merge-time removeWorktree call
// that failed, and — deliberately — PRs closed without merging or issues
// that got blocked: nothing is lost by deleting a local worktree, the
// branch and everything reviewable stays on GitHub, which is where a human
// actually looks when something's blocked, not this filesystem).
export function branchesToSweep(dirNames: string[], allPrs: PullRequestStatus[]): string[] {
  const openBranches = new Set(allPrs.map((pr) => pr.headRefName));
  return dirNames.flatMap((name) => {
    const branch = branchFromWorktreeDirName(name);
    if (!branch) return []; // not a ronin worktree dir — leave it alone
    const isPlanWorktree = branch.endsWith('/plan');
    return isPlanWorktree || !openBranches.has(branch) ? [branch] : [];
  });
}

// The alternative to sweeping is an unbounded pile of stale checkouts and
// their Docker stacks — a real problem now that tick() processes several
// issues concurrently, so their Docker stacks can be up at the same time
// too (see concurrency.ts). Reuses tick()'s already-batched allPrs — no
// extra GitHub call. Called at the very start of tick(), before this tick's
// own new worktrees exist, so it never races a worktree that's
// mid-creation for work just starting.
export async function sweepOrphanedWorktrees(allPrs: PullRequestStatus[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(activeRepo().worktreeBasePath);
  } catch {
    return; // nothing created yet
  }

  for (const branch of branchesToSweep(entries, allPrs)) {
    await removeWorktree(branch);
  }
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
