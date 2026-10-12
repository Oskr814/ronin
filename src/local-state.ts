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
  // PR number -> last head SHA an external-review run actually completed
  // for — see docs/superpowers/specs/2026-08-20-external-pr-review-design.md.
  // A PR with no entry (or a stale one) is due for a fresh review next tick.
  lastReviewedSha: Record<string, string>;
  // Most recent release changelog.ts has already handled (successfully, or
  // failed-and-notified — see processChangelogCandidate) for this repo.
  // Compared by publishedAt, not by tag, since tags aren't
  // reliably sortable. Undefined means "never seeded" — findReleasesNeeding
  // Changelog treats that as "mark the current latest as the baseline,
  // generate nothing" rather than backfilling every release ever published.
  lastChangelogRelease?: { tag: string; publishedAt: string };
  // App → the night (local date) its nightly exploration was last started.
  // One start per app per night, success or not: a run that fails must not
  // be relaunched every tick until morning — see exploration-schedule.ts.
  nightlyExploration: Record<string, string>;
  // Issue → the Remote Control interview session open for it (interview.ts),
  // so a later tick can close it even after a restart.
  interviews: Record<string, { sessionId: string; startedAt: string; url?: string; nonce?: string; resume?: InterviewResume }>;
  // /spec runs to redo now that an interview got the answers they lacked.
  pendingSpecs: Array<{ issueNumber: number; appName: string; instruction?: string }>;
}

// What to do once an interview gets its answers: put a ronin issue back in
// progress (the default), or redo a /spec on an issue ronin doesn't manage.
export type InterviewResume = { kind: 'issue' } | { kind: 'spec'; appName: string; instruction?: string };

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
    return {
      claimedIssues: raw.claimedIssues ?? [],
      checksPendingCounts: raw.checksPendingCounts ?? {},
      lastReviewedSha: raw.lastReviewedSha ?? {},
      lastChangelogRelease: raw.lastChangelogRelease,
      nightlyExploration: raw.nightlyExploration ?? {},
      interviews: raw.interviews ?? {},
      pendingSpecs: raw.pendingSpecs ?? [],
    };
  } catch {
    return { claimedIssues: [], checksPendingCounts: {}, lastReviewedSha: {}, nightlyExploration: {}, interviews: {}, pendingSpecs: [] };
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

export async function getLastReviewedSha(prNumber: number): Promise<string | undefined> {
  const state = await readLocalState();
  return state.lastReviewedSha[prNumber];
}

// Without this, lastReviewedSha grows one permanent entry per external PR
// ever reviewed — nothing else ever deletes from it. Called from
// findPrsNeedingReview with the currently-open external PR numbers, so
// merged/closed PRs drop out as a side effect of every discovery run (no
// separate cron needed).
export async function pruneLastReviewedSha(openPrNumbers: number[]): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const keep = new Set(openPrNumbers.map(String));
    for (const key of Object.keys(state.lastReviewedSha)) {
      if (!keep.has(key)) delete state.lastReviewedSha[key];
    }
    await writeLocalState(state);
  });
}

export async function setLastReviewedSha(prNumber: number, sha: string): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    state.lastReviewedSha[prNumber] = sha;
    await writeLocalState(state);
  });
}

export async function getLastChangelogRelease(): Promise<{ tag: string; publishedAt: string } | undefined> {
  const state = await readLocalState();
  return state.lastChangelogRelease;
}

export async function setLastChangelogRelease(tag: string, publishedAt: string): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    state.lastChangelogRelease = { tag, publishedAt };
    await writeLocalState(state);
  });
}

export async function getNightlyExploration(): Promise<Record<string, string>> {
  return (await readLocalState()).nightlyExploration;
}

export async function setNightlyExploration(appName: string, night: string): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    state.nightlyExploration[appName] = night;
    await writeLocalState(state);
  });
}

export async function getInterviews(): Promise<LocalState['interviews']> {
  return (await readLocalState()).interviews;
}

export async function setInterview(issueNumber: number, interview: LocalState['interviews'][string] | null): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    if (interview) state.interviews[issueNumber] = interview;
    else delete state.interviews[issueNumber];
    await writeLocalState(state);
  });
}

export async function addPendingSpec(spec: LocalState['pendingSpecs'][number]): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    if (!state.pendingSpecs.some((p) => p.issueNumber === spec.issueNumber)) state.pendingSpecs.push(spec);
    await writeLocalState(state);
  });
}

export async function takePendingSpecs(): Promise<LocalState['pendingSpecs']> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const taken = state.pendingSpecs;
    state.pendingSpecs = [];
    await writeLocalState(state);
    return taken;
  });
}
