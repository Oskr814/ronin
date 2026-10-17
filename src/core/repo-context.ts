import { AsyncLocalStorage } from 'node:async_hooks';
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
  // exploration/schedule.ts. Absent: no nightly exploration (/explore still
  // works on demand).
  explore?: string[];
  // Model/effort defaults for the Claude account this entry runs under
  // (claudeConfigDir), for when that account can't afford the global ones —
  // see config.ts's agentModelFor for how they combine with the env vars.
  agent?: AgentDefaults;
  // Linear (#101): the env var holding the workspace's API key, for projects
  // and cycles (core/linear-api.ts). Absent: nothing is read from Linear.
  linear?: { apiKeyEnv: string };
}

export interface AgentDefaults {
  // Replace AGENT_MODEL / AGENT_EFFORT for this repo.
  model?: string;
  effort?: string;
  // Per task type ("external-review", "fix-review", …): win over everything,
  // AGENT_MODEL_<TASK_TYPE> included.
  models?: Record<string, string>;
  efforts?: Record<string, string>;
  // Replaces EXTERNAL_REVIEW_WORKER_MODEL (also the self-review subagent).
  reviewWorkerModel?: string;
}

interface ActiveRepo extends RepoEntry {
  worktreeBasePath: string;
}

// Per async call chain, not a module-level slot: the tick walks its repos
// in sequence, but the dashboard server reads every repo at once
// (Promise.all over repos.json, plus whatever a page asks meanwhile). With
// a shared slot one repo's withActiveRepo overwrote another's halfway, and
// its awaits went on reading the wrong repo (the dashboard lost a preview
// that way, looking for it in the other repo's worktrees).
const storage = new AsyncLocalStorage<ActiveRepo>();

// Null outside an active withActiveRepo call is intentional: anything that
// tries to read repo state outside the loop should crash loudly instead of
// silently reusing a previous repo's context.
// For code that also runs outside the loop (scripts, config defaults) and
// just falls back to the global value there.
export function currentRepo(): ActiveRepo | null {
  return storage.getStore() ?? null;
}

export function activeRepo(): ActiveRepo {
  const current = storage.getStore();
  if (!current) throw new Error('activeRepo() called outside withActiveRepo()');
  return current;
}

export async function withActiveRepo<T>(entry: RepoEntry, fn: () => Promise<T>): Promise<T> {
  return storage.run({
    ...entry,
    // Sibling directory to the product repo checkout, not inside it —
    // worktrees come and go per task and should never be mistaken for the
    // main checkout. Same convention config.ts used to derive this
    // globally; WORKTREE_BASE_PATH stays a valid override for every repo.
    worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(entry.productRepoPath, '..', 'ronin-worktrees'),
  }, fn);
}
