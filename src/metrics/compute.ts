import type { MIssue, MPr, RepoData } from './collect.js';
import { blockCategory, type BlockEvent } from './blocks.js';

// Métricas (#222), computed from what collect.ts keeps: pure, so the page's
// numbers are tested here and not against GitHub. Every time is in calendar
// days (a weekend counts), and "resolved" is an issue closed as completed:
// one closed as not planned is counted apart and never in the times.

export type Period = 7 | 30 | 90;
export const PERIODS: Period[] = [7, 30, 90];

const DAY = 86_400_000;
// An assigned issue that hasn't moved in this long is "quiet" in its
// person's row; in the backlog's health, the longer one.
const QUIET_MS = 14 * DAY;
const STALE_MS = 30 * DAY;
// A PR waiting for its review longer than this is listed.
const REVIEW_WAIT_MS = 2 * DAY;
const OPEN_LIST = 7;
const WAITING_LIST = 12;

interface Issue extends MIssue { repo: string }
interface Pr extends MPr { repo: string }

export interface MetricsInput {
  repos: RepoData[];
  blocks: BlockEvent[];
  // ronin's GitHub account: its row, and the ronin section.
  ronin: string;
  days: Period;
  now: number;
}

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const within = (iso: string | null | undefined, a: number, b: number) => { const v = t(iso); return v >= a && v < b; };

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The value under which `p` of them fall (nearest rank).
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

const resolved = (i: Issue, a: number, b: number) => i.reason === 'completed' && within(i.closedAt, a, b);
const resolution = (i: Issue) => t(i.closedAt) - t(i.createdAt);
// Open at instant `at`: created before, and not closed yet then.
const openAt = (i: Issue, at: number) => t(i.createdAt) < at && !(i.closedAt && t(i.closedAt) < at);
const isBot = (login: string, ronin: string) => login !== ronin && (login.endsWith('[bot]') || login === '');

// When a PR started waiting for a review: its first request, but not
// before it left draft; with no request, when it was ready (or opened).
function askedAt(pr: Pr): number {
  const ready = pr.readyAt ? t(pr.readyAt) : t(pr.createdAt);
  return pr.requests.length ? Math.max(Math.min(...pr.requests.map((r) => t(r.at))), ready) : ready;
}
const othersReviews = (pr: Pr) => pr.reviews.filter((r) => r.author !== pr.author).sort((x, y) => t(x.at) - t(y.at));
const firstReviewAt = (pr: Pr) => { const r = othersReviews(pr)[0]; return r ? t(r.at) : NaN; };
const changesRequested = (pr: Pr) => pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && r.author !== pr.author).length;

// Who still owes a PR their review: asked, and no review of theirs since.
function pendingReviewers(pr: Pr): Array<{ reviewer: string; since: number }> {
  const last = new Map<string, number>();
  for (const r of pr.requests) last.set(r.reviewer, Math.max(last.get(r.reviewer) ?? 0, t(r.at)));
  return [...last].filter(([who, at]) => !pr.reviews.some((r) => r.author === who && t(r.at) >= at)).map(([reviewer, since]) => ({ reviewer, since }));
}

// The chart's bars: by day for 7 days, by week otherwise (8 or 13 of them),
// the last one ending now.
export function buckets(days: Period, now: number): Array<{ a: number; b: number }> {
  const step = days === 7 ? DAY : 7 * DAY;
  const count = days === 7 ? 7 : days === 30 ? 8 : 13;
  return Array.from({ length: count }, (_, k) => { const b = now - (count - 1 - k) * step; return { a: b - step, b }; });
}

interface Totals {
  resolved: number;
  opened: number;
  resolutionMedian: number | null;
  resolutionP90: number | null;
  merged: number;
  firstReviewMedian: number | null;
  mergeMedian: number | null;
  backlog: number;
}

function totals(issues: Issue[], prs: Pr[], a: number, b: number): Totals {
  const done = issues.filter((i) => resolved(i, a, b));
  const merged = prs.filter((p) => within(p.mergedAt, a, b));
  const reviewed = prs.filter((p) => { const f = firstReviewAt(p); return f >= a && f < b; });
  return {
    resolved: done.length,
    opened: issues.filter((i) => within(i.createdAt, a, b)).length,
    resolutionMedian: median(done.map(resolution)),
    resolutionP90: percentile(done.map(resolution), 0.9),
    merged: merged.length,
    firstReviewMedian: median(reviewed.map((p) => Math.max(0, firstReviewAt(p) - askedAt(p)))),
    mergeMedian: median(merged.map((p) => t(p.mergedAt) - t(p.createdAt))),
    backlog: issues.filter((i) => openAt(i, b)).length,
  };
}

const RESOLUTION_TRAMOS: Array<[number, number, string]> = [[0, 1, '< 1 d'], [1, 3, '1–3 d'], [3, 7, '3–7 d'], [7, 14, '1–2 sem'], [14, 30, '2–4 sem'], [30, Infinity, '> 1 mes']];
const AGE_TRAMOS: Array<[number, number, string]> = [[0, 7, 'Menos de 1 sem'], [7, 30, '1 a 4 sem'], [30, 90, '1 a 3 meses'], [90, Infinity, 'Más de 3 meses']];
const tramos = (ms: number[], edges: Array<[number, number, string]>) => edges.map(([lo, hi, label]) => ({ label, count: ms.filter((v) => v / DAY >= lo && v / DAY < hi).length }));

// An issue's kind, from its labels; repos label differently, so only the usual names.
export function issueKind(labels: string[]): 'bug' | 'feature' | 'otro' {
  const names = labels.map((l) => l.toLowerCase());
  if (names.some((l) => l === 'bug' || l.startsWith('bug') || l === 'error')) return 'bug';
  if (names.some((l) => ['enhancement', 'feature', 'mejora', 'feat'].includes(l) || l.startsWith('feature'))) return 'feature';
  return 'otro';
}

export function computeMetrics(input: MetricsInput) {
  const { days, now, ronin } = input;
  const a = now - days * DAY, pa = a - days * DAY;
  const issues: Issue[] = input.repos.flatMap((r) => Object.values(r.issues).map((i) => ({ ...i, repo: r.repo })));
  const prs: Pr[] = input.repos.flatMap((r) => Object.values(r.prs).map((p) => ({ ...p, repo: r.repo })));
  const repoNames = new Set(input.repos.map((r) => r.repo));

  const current = totals(issues, prs, a, now);
  const previous = totals(issues, prs, pa, a);
  const bks = buckets(days, now);
  const series = bks.map((bk) => ({ from: new Date(bk.a).toISOString(), to: new Date(bk.b).toISOString(), ...totals(issues, prs, bk.a, bk.b) }));

  const done = issues.filter((i) => resolved(i, a, now));
  const kinds = (['bug', 'feature', 'otro'] as const).map((kind) => {
    const of = done.filter((i) => issueKind(i.labels) === kind);
    return { kind, resolved: of.length, median: median(of.map(resolution)) };
  });

  // --- per person: whoever has something assigned, merged or reviewed
  const open = issues.filter((i) => !i.closedAt);
  const logins = new Set<string>();
  for (const i of issues) if (!i.closedAt || resolved(i, a, now)) i.assignees.forEach((l) => logins.add(l));
  for (const p of prs) {
    if (within(p.mergedAt, a, now)) logins.add(p.author);
    for (const r of p.reviews) if (within(r.at, a, now)) logins.add(r.author);
    if (!p.closedAt && !p.draft) pendingReviewers(p).forEach((r) => logins.add(r.reviewer));
  }
  const people = [...logins].filter((l) => !isBot(l, ronin)).map((login) => {
    const mine = issues.filter((i) => i.assignees.includes(login));
    const mineOpen = mine.filter((i) => !i.closedAt);
    const mineDone = mine.filter((i) => resolved(i, a, now));
    const myMerged = prs.filter((p) => p.author === login && within(p.mergedAt, a, now));
    // Their first review on each PR of someone else, in the period.
    const reviewed = prs.filter((p) => p.author !== login).map((p) => {
      const first = p.reviews.filter((r) => r.author === login).sort((x, y) => t(x.at) - t(y.at))[0];
      if (!first || !within(first.at, a, now)) return null;
      const asked = p.requests.filter((r) => r.reviewer === login && t(r.at) <= t(first.at)).map((r) => t(r.at));
      return { wait: asked.length ? t(first.at) - Math.max(...asked) : null };
    }).filter((x): x is { wait: number | null } => x !== null);
    const isRonin = login === ronin;
    return {
      login,
      agent: isRonin,
      open: mineOpen.length,
      quiet: mineOpen.filter((i) => now - t(i.updatedAt) > QUIET_MS).length,
      resolved: mineDone.length,
      resolutionMedian: median(mineDone.map(resolution)),
      merged: myMerged.length,
      reviewRounds: myMerged.length ? myMerged.reduce((s, p) => s + changesRequested(p), 0) / myMerged.length : null,
      reviews: isRonin ? null : reviewed.length,
      reviewWaitMedian: isRonin ? null : median(reviewed.map((r) => r.wait).filter((w): w is number => w !== null)),
      waitingOnThem: isRonin ? null : prs.filter((p) => !p.closedAt && !p.draft && pendingReviewers(p).some((r) => r.reviewer === login)).length,
      perBucket: bks.map((bk) => mine.filter((i) => resolved(i, bk.a, bk.b)).length),
      openList: [...mineOpen].sort((x, y) => t(x.updatedAt) - t(y.updatedAt)).slice(0, OPEN_LIST).map((i) => ({
        repo: i.repo, number: i.number, title: i.title, updatedAt: i.updatedAt, blocked: i.labels.includes('ronin:blocked'),
      })),
    };
  }).sort((x, y) => y.resolved - x.resolved || y.open - x.open || x.login.localeCompare(y.login));

  // --- the flow's health
  const openPrs = prs.filter((p) => !p.closedAt && !p.draft);
  const waiting = openPrs.flatMap((p) => {
    const pending = pendingReviewers(p).filter((r) => now - r.since > REVIEW_WAIT_MS);
    return pending.length ? [{ repo: p.repo, number: p.number, title: p.title, author: p.author, reviewers: pending.map((r) => r.reviewer), since: new Date(Math.min(...pending.map((r) => r.since))).toISOString() }] : [];
  }).sort((x, y) => x.since.localeCompare(y.since));
  const mergedNow = prs.filter((p) => within(p.mergedAt, a, now));
  const health = {
    open: open.length,
    ages: tramos(open.map((i) => now - t(i.createdAt)), AGE_TRAMOS),
    unassigned: open.filter((i) => !i.assignees.length).length,
    stale: open.filter((i) => i.assignees.length && now - t(i.updatedAt) > STALE_MS).length,
    reopened: done.filter((i) => i.reopenedAt.length).length,
    notPlanned: issues.filter((i) => i.reason === 'not_planned' && within(i.closedAt, a, now)).length,
    waitingReview: waiting.slice(0, WAITING_LIST),
    waitingReviewTotal: waiting.length,
    mergeMedian: current.mergeMedian,
    firstTry: mergedNow.length ? mergedNow.filter((p) => changesRequested(p) === 0).length / mergedNow.length : null,
  };

  // --- deploys: published, non-prerelease releases; each merged PR goes out
  // with the first one after its merge.
  const releasesOf = (repo: string) => (input.repos.find((r) => r.repo === repo)?.releases ?? []).filter((r) => !r.prerelease).map((r) => t(r.publishedAt)).sort((x, y) => x - y);
  const released = input.repos.filter((r) => r.releases.some((x) => !x.prerelease));
  const releasesIn = (x: number, y: number) => released.reduce((s, r) => s + releasesOf(r.repo).filter((v) => v >= x && v < y).length, 0);
  const leads = prs.filter((p) => p.mergedAt && released.some((r) => r.repo === p.repo)).flatMap((p) => {
    const out = releasesOf(p.repo).find((v) => v >= t(p.mergedAt));
    return out !== undefined && out >= a && out < now ? [out - t(p.mergedAt)] : [];
  });
  const deploys = released.length ? {
    count: releasesIn(a, now),
    previous: releasesIn(pa, a),
    perWeek: releasesIn(a, now) / (days / 7),
    leadMedian: median(leads),
    perBucket: bks.map((bk) => releasesIn(bk.a, bk.b)),
    repos: released.map((r) => r.repo),
  } : null;

  // --- ronin
  const roninDone = done.filter((i) => i.assignees.includes(ronin));
  const peopleDone = done.filter((i) => !i.assignees.includes(ronin));
  const roninMerged = mergedNow.filter((p) => p.author === ronin);
  // The blocks in the period: the record's, plus each ronin:blocked label
  // the record doesn't have (older than it), without a reason.
  const recorded = input.blocks.filter((e) => repoNames.has(e.repo) && within(e.at, a, now));
  const unrecorded = issues.flatMap((i) => i.blockedAt.filter((at) => within(at, a, now) && !input.blocks.some((e) => e.repo === i.repo && e.item === i.number && Math.abs(t(e.at) - t(at)) < 10 * 60_000)));
  const reasons = new Map<string, number>();
  for (const e of recorded) reasons.set(blockCategory(e.reason), (reasons.get(blockCategory(e.reason)) ?? 0) + 1);
  if (unrecorded.length) reasons.set('Sin motivo registrado', unrecorded.length);
  const roninSection = {
    share: done.length ? roninDone.length / done.length : null,
    resolved: roninDone.length,
    peopleResolved: peopleDone.length,
    resolutionMedian: median(roninDone.map(resolution)),
    peopleResolutionMedian: median(peopleDone.map(resolution)),
    unblocked: roninDone.length ? roninDone.filter((i) => !i.blockedAt.length).length / roninDone.length : null,
    firstTry: roninMerged.length ? roninMerged.filter((p) => changesRequested(p) === 0).length / roninMerged.length : null,
    attempts: roninMerged.length ? roninMerged.reduce((s, p) => s + p.attempts, 0) / roninMerged.length : null,
    blocks: recorded.length + unrecorded.length,
    blockReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count),
  };

  return {
    days,
    from: new Date(a).toISOString(),
    to: new Date(now).toISOString(),
    current,
    previous,
    series,
    resolution: { tramos: tramos(done.map(resolution), RESOLUTION_TRAMOS), kinds },
    people,
    health,
    deploys,
    ronin: roninSection,
  };
}

export type MetricsView = ReturnType<typeof computeMetrics>;
