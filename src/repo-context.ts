import { join } from 'node:path';

export interface RepoEntry {
  productRepo: string;
  productRepoPath: string;
  claudeConfigDir?: string;
  // Per-repo override for config.worktreeBaseRef (e.g. "origin/odoo-main"
  // for a repo whose default/active branch isn't "main") — same override
  // pattern as claudeConfigDir. Consumers read
  // `activeRepo().worktreeBaseRef ?? config.worktreeBaseRef`.
  worktreeBaseRef?: string;
  // Opt-in: when both of these are set, a new release (webhook event
  // release/released, or the tick reconciliation in changelog.ts) generates
  // an entry in this "owner/repo" changelog repo (e.g. "redmotos/changelog")
  // and pushes it straight to that repo's own main — see changelog.ts.
  // Absent for every repo by default. Both fields travel together: either
  // both are set or neither is (validated in repos.ts).
  changelogRepo?: string;
  // Local clone of changelogRepo, pre-created by a human exactly like
  // productRepoPath — ronin never clones this itself, only fetches/resets it
  // (see changelog.ts's ensureChangelogRepoUpToDate).
  changelogRepoPath?: string;
  // Apps of this repo's ronin.app.json that get explored every night — see
  // exploration-schedule.ts. Absent: no nightly exploration (/explore still
  // works on demand).
  explore?: string[];
}

interface ActiveRepo extends RepoEntry {
  worktreeBasePath: string;
}

// Mutable on purpose, not AsyncLocalStorage: repos are processed strictly
// in sequence (tick.ts's outer loop), and the only concurrency that ever
// runs is *within* one active repo (config.tickConcurrency issues at once) —
// see docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md §3.
// A single module-level slot is safe under that constraint and much
// simpler than threading a repo parameter through every function.
let current: ActiveRepo | null = null;

// Null outside an active withActiveRepo call is intentional: anything that
// tries to read repo state outside the loop should crash loudly instead of
// silently reusing a previous repo's context.
export function activeRepo(): ActiveRepo {
  if (!current) throw new Error('activeRepo() called outside withActiveRepo()');
  return current;
}

export async function withActiveRepo<T>(entry: RepoEntry, fn: () => Promise<T>): Promise<T> {
  current = {
    ...entry,
    // Sibling directory to the product repo checkout, not inside it —
    // worktrees come and go per task and should never be mistaken for the
    // main checkout. Same convention config.ts used to derive this
    // globally; WORKTREE_BASE_PATH stays a valid override for every repo.
    worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(entry.productRepoPath, '..', 'ronin-worktrees'),
  };
  try {
    return await fn();
  } finally {
    current = null;
  }
}
