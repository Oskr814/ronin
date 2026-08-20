import { join } from 'node:path';

export interface RepoEntry {
  productRepo: string;
  productRepoPath: string;
  claudeConfigDir?: string;
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
