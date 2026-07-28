import { readFile, writeFile } from 'node:fs/promises';
import { config, LABEL_STATES } from './config.js';
import { getIssueLabels, addIssueLabel, removeIssueLabel } from './github.js';

const CLAIM_PREFIX = 'valeria:locked-by-';

function myLabel(): string {
  return `${CLAIM_PREFIX}${config.machineId}`;
}

interface LocalState {
  claimedIssues: number[];
}

async function readLocalState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(config.localStatePath, 'utf8')) as LocalState;
  } catch {
    return { claimedIssues: [] };
  }
}

async function writeLocalState(state: LocalState): Promise<void> {
  await writeFile(config.localStatePath, JSON.stringify(state, null, 2));
}

// True if this machine now owns the issue and may act on it. Local state is
// a fast-path cache, not the source of truth — GitHub labels are — so a
// missing/corrupt state file just means re-deriving ownership from GitHub,
// never a false claim.
export async function tryClaim(issueNumber: number): Promise<boolean> {
  const state = await readLocalState();
  if (state.claimedIssues.includes(issueNumber)) return true;

  const labels = await getIssueLabels(issueNumber);
  const existingClaims = labels.filter((l) => l.startsWith(CLAIM_PREFIX));
  if (existingClaims.length > 0 && !existingClaims.includes(myLabel())) {
    return false; // another machine already holds this one
  }

  await addIssueLabel(issueNumber, myLabel());

  // Two machines can both pass the check above and both add their own claim
  // label in the same instant — `--add-label` isn't compare-and-swap, so
  // both writes succeed independently. Re-reading resolves the collision
  // deterministically (lexicographically smallest machine id wins) without
  // needing a timestamp or a wait.
  const after = (await getIssueLabels(issueNumber)).filter((l) => l.startsWith(CLAIM_PREFIX)).sort();
  if (after[0] !== myLabel()) {
    await removeIssueLabel(issueNumber, myLabel());
    return false;
  }

  state.claimedIssues.push(issueNumber);
  await writeLocalState(state);
  return true;
}

// Only actually releases once the issue has left `in-progress` (blocked or
// done) — while it's still in progress, this machine keeps the claim so
// every later tick hits the local-state fast path instead of re-contending.
export async function releaseIfNoLongerInProgress(issueNumber: number): Promise<void> {
  const labels = await getIssueLabels(issueNumber);
  if (labels.includes(LABEL_STATES['in-progress'])) return;

  const state = await readLocalState();
  state.claimedIssues = state.claimedIssues.filter((n) => n !== issueNumber);
  await writeLocalState(state);
  await removeIssueLabel(issueNumber, myLabel()).catch(() => {});
}
