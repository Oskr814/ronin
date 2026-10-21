import { config, LABEL_STATES } from '../config/config.js';
import { getIssueLabels, addIssueLabel, removeIssueLabel } from '../github/github.js';
import { readLocalState, writeLocalState, withLocalStateLock } from './local-state.js';

const RUNNER_PREFIX = 'ronin:runner-';

// Same label prefix used for spec-PR assignment (applied manually by a
// human) and the issue claim lock (applied automatically here) — see
// docs/DESIGN.md §1 and §9. Exported so discovery can search for PRs
// assigned to this runner with the identical string.
export function runnerLabel(): string {
  return `${RUNNER_PREFIX}${config.runnerId}`;
}

// True if this runner now owns the issue and may act on it. Local state is
// a fast-path cache, not the source of truth — GitHub labels are — so a
// missing/corrupt state file just means re-deriving ownership from GitHub,
// never a false claim.
export async function tryClaim(issueNumber: number): Promise<boolean> {
  // Whole function, not just the state.claimedIssues read/write: tick() now
  // runs several issues' pipelines concurrently (see concurrency.ts), and
  // two of them calling tryClaim at once must never interleave — see
  // local-state.ts's withLocalStateLock. Cheap either way: this is a couple
  // of label reads/writes, never the long `claude -p` run a concurrent slot
  // exists to overlap.
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    if (state.claimedIssues.includes(issueNumber)) return true;

    const labels = await getIssueLabels(issueNumber);
    const existingClaims = labels.filter((l) => l.startsWith(RUNNER_PREFIX));
    if (existingClaims.length > 0 && !existingClaims.includes(runnerLabel())) {
      return false; // another runner already holds this one
    }

    await addIssueLabel(issueNumber, runnerLabel());

    // Two runners can both pass the check above and both add their own claim
    // label in the same instant — `--add-label` isn't compare-and-swap, so
    // both writes succeed independently. Re-reading resolves the collision
    // deterministically (lexicographically smallest runner id wins) without
    // needing a timestamp or a wait.
    const after = (await getIssueLabels(issueNumber)).filter((l) => l.startsWith(RUNNER_PREFIX)).sort();
    if (after[0] !== runnerLabel()) {
      await removeIssueLabel(issueNumber, runnerLabel());
      return false;
    }

    state.claimedIssues.push(issueNumber);
    await writeLocalState(state);
    return true;
  });
}

// Only actually releases once the issue has left `in-progress` (blocked or
// done) — while it's still in progress, this runner keeps the claim so
// every later tick hits the local-state fast path instead of re-contending.
export async function releaseIfNoLongerInProgress(issueNumber: number): Promise<void> {
  const labels = await getIssueLabels(issueNumber);
  if (labels.includes(LABEL_STATES['in-progress'])) return;

  // See the note in tryClaim above on why this is locked too.
  await withLocalStateLock(async () => {
    const state = await readLocalState();
    state.claimedIssues = state.claimedIssues.filter((n) => n !== issueNumber);
    await writeLocalState(state);
  });
  await removeIssueLabel(issueNumber, runnerLabel()).catch(() => {});
}
