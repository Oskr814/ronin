import { listReleases, type Release } from '../../platform/github/github.js';
import { getLastChangelogRelease, setLastChangelogRelease } from '../../platform/state/local-state.js';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { log } from '../../platform/logger.js';
import { host } from '../../platform/host/host.js';


export interface ChangelogCandidate {
  release: Release;
}

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as spike.ts/external-review.ts. No-op for any repo
// that hasn't opted in (see repo-context.ts's changelogRepo/changelogRepoPath).
export async function findReleasesNeedingChangelog(): Promise<ChangelogCandidate[]> {
  if (!activeRepo().changelogRepo) return [];

  const releases = (await listReleases())
    .filter((r) => !r.isDraft && !r.isPrerelease)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)); // oldest first

  const last = await getLastChangelogRelease();
  if (!last) {
    // First run for this repo: seed the baseline at the current latest
    // release instead of generating an entry for every release ever
    // published — see docs/superpowers/plans (backfill explicitly out of
    // scope, confirmed with the user).
    const latest = releases.at(-1);
    if (latest) await setLastChangelogRelease(latest.tagName, latest.publishedAt);
    return [];
  }

  return releases.filter((r) => r.publishedAt > last.publishedAt).map((release) => ({ release }));
}

// changelogRepoPath is a plain, persistent clone a human sets up once —
// unlike worktree.ts's per-branch worktrees, there's exactly one of these
// per repo and it always tracks main, so a fetch+hard-reset is all it needs.
// Never creates the clone itself (same manual-setup contract as
// productRepoPath).
export async function ensureChangelogRepoUpToDate(): Promise<string> {
  const dir = activeRepo().changelogRepoPath;
  if (!dir) throw new Error('ensureChangelogRepoUpToDate called without changelogRepoPath set — check changelogRepo is configured in repos.json');

  await host().exec('git', ['fetch', 'origin', 'main'], { cwd: dir });
  await host().exec('git', ['checkout', 'main'], { cwd: dir });
  await host().exec('git', ['reset', '--hard', 'origin/main'], { cwd: dir });
  return dir;
}
