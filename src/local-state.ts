import { readFile, writeFile } from 'node:fs/promises';
import { config } from './config.js';

// Per-machine cache, never the source of truth for anything GitHub already
// tracks — see claim.ts's tryClaim for why a missing/corrupt file is always
// safe to treat as empty. Never committed (see .gitignore).
export interface LocalState {
  claimedIssues: number[];
  // PR number -> consecutive-tick count of "checks still pending" — kept
  // here instead of as a GitHub label because its limit (tens of ticks) would
  // otherwise mean a label swap every tick, flooding the issue's activity
  // timeline. Losing this on a process restart just means the wait starts
  // over with full patience, never less — harmless either way.
  checksPendingCounts: Record<string, number>;
}

export async function readLocalState(): Promise<LocalState> {
  try {
    const raw = JSON.parse(await readFile(config.localStatePath, 'utf8')) as Partial<LocalState>;
    return { claimedIssues: raw.claimedIssues ?? [], checksPendingCounts: raw.checksPendingCounts ?? {} };
  } catch {
    return { claimedIssues: [], checksPendingCounts: {} };
  }
}

export async function writeLocalState(state: LocalState): Promise<void> {
  await writeFile(config.localStatePath, JSON.stringify(state, null, 2));
}

export async function incrementChecksPendingCount(prNumber: number): Promise<number> {
  const state = await readLocalState();
  const next = (state.checksPendingCounts[prNumber] ?? 0) + 1;
  state.checksPendingCounts[prNumber] = next;
  await writeLocalState(state);
  return next;
}

export async function resetChecksPendingCount(prNumber: number): Promise<void> {
  const state = await readLocalState();
  if (!(prNumber in state.checksPendingCounts)) return;
  delete state.checksPendingCounts[prNumber];
  await writeLocalState(state);
}
