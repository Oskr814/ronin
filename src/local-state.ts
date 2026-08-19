import { readFile, writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';

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

// In-process serialization for the read-modify-write span around this file:
// tick() now runs several issues' pipelines concurrently (see
// concurrency.ts), and this file's own read-then-write functions below, plus
// claim.ts's tryClaim/releaseIfNoLongerInProgress, would otherwise race —
// two concurrent callers can both read before either writes, and the second
// write silently clobbers the first's update. A lost update here was always
// tolerable on its own (this is a cache, not the source of truth — see the
// LocalState doc comment above), but there's no reason to rely on that when
// serializing the whole critical section is this cheap: these are quick
// label reads/writes, never the long `claude -p` run a concurrent slot is
// actually there to overlap.
let queue: Promise<unknown> = Promise.resolve();
export function withLocalStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

// Namespaced per active repo so an issue #12 in one repo.json entry never
// shares claimedIssues/checksPendingCounts with a #12 in another — see
// docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md §4.
function statePath(): string {
  const slug = activeRepo().productRepo.replaceAll('/', '-');
  return `${config.localStatePath}.${slug}.json`;
}

export async function readLocalState(): Promise<LocalState> {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<LocalState>;
    return { claimedIssues: raw.claimedIssues ?? [], checksPendingCounts: raw.checksPendingCounts ?? {} };
  } catch {
    return { claimedIssues: [], checksPendingCounts: {} };
  }
}

export async function writeLocalState(state: LocalState): Promise<void> {
  await writeFile(statePath(), JSON.stringify(state, null, 2));
}

export async function incrementChecksPendingCount(prNumber: number): Promise<number> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const next = (state.checksPendingCounts[prNumber] ?? 0) + 1;
    state.checksPendingCounts[prNumber] = next;
    await writeLocalState(state);
    return next;
  });
}

export async function resetChecksPendingCount(prNumber: number): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    if (!(prNumber in state.checksPendingCounts)) return;
    delete state.checksPendingCounts[prNumber];
    await writeLocalState(state);
  });
}
