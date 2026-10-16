import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from './worker-launch.js';
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
  // PR number -> failure signature (failure-signature.ts) -> how many times
  // its checks were seen failing that way. Never reset on a green run, like
  // fabro's circuit breaker: "fix, pass, break the same way again" is still
  // not converging. Losing it only means more patience, never less — the
  // attempts label keeps the hard limit (docs/BLOCKING.md).
  failureSignatures: Record<string, Record<string, number>>;
  // Most recent release changelog.ts has already handled (successfully, or
  // failed-and-notified — see processChangelogCandidate) for this repo.
  // Compared by publishedAt, not by tag, since tags aren't
  // reliably sortable. Undefined means "never seeded" — findReleasesNeeding
  // Changelog treats that as "mark the current latest as the baseline,
  // generate nothing" rather than backfilling every release ever published.
  lastChangelogRelease?: { tag: string; publishedAt: string };
  // App → the night (local date) its nightly exploration was last started.
  // One start per app per night, success or not: a run that fails must not
  // be relaunched every tick until morning — see exploration/schedule.ts.
  nightlyExploration: Record<string, string>;
  // Issue → the Remote Control interview session open for it (interview.ts),
  // so a later tick can close it even after a restart.
  interviews: Record<string, { sessionId: string; startedAt: string; url?: string; nonce?: string; resume?: InterviewResume }>;
  // /spec runs to redo now that an interview got the answers they lacked.
  pendingSpecs: Array<{ issueNumber: number; appName: string; instruction?: string }>;
  // Comments ronin is done with ("issue-<id>"/"review-<id>" -> when), and
  // since when that's tracked here rather than by ronin's 👀 on them — which
  // now only says "got it" (see processed-comments.ts).
  processedComments: Record<string, string>;
  processedSince?: string;
}

// What to do once an interview gets its answers: put a ronin issue back in
// progress (the default), or redo a /spec on an issue ronin doesn't manage.
export type InterviewResume = { kind: 'issue' } | { kind: 'spec'; appName: string; instruction?: string };

// Serializes the read-modify-write span around this file: tick() runs
// several issues' pipelines concurrently (see concurrency.ts), and the event
// handlers (webhooks/handler.ts) are other processes writing it alongside the
// tick. This file's own read-then-write functions below, plus claim.ts's
// tryClaim/releaseIfNoLongerInProgress, would otherwise race — two callers
// can both read before either writes, and the second write silently clobbers
// the first's update. Inside the process a promise queue; across processes a
// lock file next to the state, held only for that quick span (label
// reads/writes, never the long `claude -p` run).
const STATE_LOCK_POLL_MS = 50;
let queue: Promise<unknown> = Promise.resolve();
export function withLocalStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const locked = async () => {
    const lock = `${config.localStatePath}.lock`;
    while (!(await acquireLock(lock))) await sleep(STATE_LOCK_POLL_MS);
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  };
  const result = queue.then(locked, locked);
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
      failureSignatures: raw.failureSignatures ?? {},
      lastChangelogRelease: raw.lastChangelogRelease,
      nightlyExploration: raw.nightlyExploration ?? {},
      interviews: raw.interviews ?? {},
      pendingSpecs: raw.pendingSpecs ?? [],
      processedComments: raw.processedComments ?? {},
      processedSince: raw.processedSince,
    };
  } catch {
    return { claimedIssues: [], checksPendingCounts: {}, lastReviewedSha: {}, failureSignatures: {}, nightlyExploration: {}, interviews: {}, pendingSpecs: [], processedComments: {} };
  }
}

// Written aside and renamed into place: another process reading it meanwhile
// sees the old file or the new one, never half of one — which readLocalState
// would take for an empty state, and the next write would persist.
export async function writeLocalState(state: LocalState): Promise<void> {
  const tmp = `${statePath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, statePath());
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

// How many times, this one included, the PR's checks failed with this signature.
export async function recordFailureSignature(prNumber: number, hash: string): Promise<number> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const seen = state.failureSignatures[prNumber] ?? {};
    seen[hash] = (seen[hash] ?? 0) + 1;
    state.failureSignatures[prNumber] = seen;
    await writeLocalState(state);
    return seen[hash];
  });
}

// Called with every open ronin PR, so a merged or closed one drops out.
export async function pruneFailureSignatures(openPrNumbers: number[]): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const keep = new Set(openPrNumbers.map(String));
    const stale = Object.keys(state.failureSignatures).filter((key) => !keep.has(key));
    if (stale.length === 0) return;
    for (const key of stale) delete state.failureSignatures[key];
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

// What's done, and since when it's tracked here — set the first time it's
// asked for, so it's never later than the first comment tracked this way.
export async function getProcessedComments(): Promise<{ since: string; done: Set<string> }> {
  const state = await readLocalState();
  if (state.processedSince) return { since: state.processedSince, done: new Set(Object.keys(state.processedComments)) };
  return withLocalStateLock(async () => {
    const fresh = await readLocalState();
    fresh.processedSince ??= new Date().toISOString();
    await writeLocalState(fresh);
    return { since: fresh.processedSince, done: new Set(Object.keys(fresh.processedComments)) };
  });
}

// Entries older than `maxAgeMs` go: a comment that old counts as done anyway
// (see processed-comments.ts).
export async function recordProcessedComment(key: string, maxAgeMs: number): Promise<void> {
  return withLocalStateLock(async () => {
    const state = await readLocalState();
    const now = Date.now();
    state.processedComments[key] = new Date(now).toISOString();
    for (const [k, at] of Object.entries(state.processedComments)) {
      if (now - Date.parse(at) > maxAgeMs) delete state.processedComments[k];
    }
    await writeLocalState(state);
  });
}
