import type { UsageMeasurement } from '../../platform/claude/claude-usage.js';
import type { AccountPlan } from '../../platform/claude/claude-plans.js';
import type { RepoData } from './collect.js';
import { percentile } from './compute.js';

// Métricas → Suscripción (#234): how much of each Claude account's quota
// gets used, and how much of that is ronin. Pure, like compute.ts: the view
// (subscription-view.ts) reads the files and hands them here.
//
// The quota comes from the measurements each `claude -p` run reports
// (claude-usage.ts, logs/usage/history/): the fraction used of the weekly
// window and of the 5-hour one, and when each resets. It counts everything
// the account does, ronin or not. A week closed when its resetsAt moved on;
// its close is the highest measurement in it (the use is cumulative).
//
// ronin's part is an estimate. In each interval between two measurements
// ronin knows what it spent (costUsd, what the run would have cost on the
// API). The intervals where only ronin used the account give how much quota
// each dollar moves; anyone else using it at the same time only pushes that
// up. So a low percentile of quota-per-dollar over the last weeks is taken
// as ronin's rate, and whatever rose above it in an interval goes to others.
// It's per account, not per model: costUsd already weighs the model, the
// same way the quota does.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Two resetsAt this close are the same window: they can come back a little
// off from one run to the next.
const SAME_WEEK_MS = 2 * HOUR;
const SAME_WINDOW_MS = 10 * 60_000;
// Intervals are merged until ronin spent this much in them: the quota comes
// in whole percents, and a cheap run moves it by 0 or 1.
const MIN_INTERVAL_USD = 1;
const CALIBRATION_DAYS = 28;
const CALIBRATION_PERCENTILE = 0.25;
const MIN_CALIBRATION_INTERVALS = 4;
const PROJECTION_MS = 48 * HOUR;
const WEEKS_SHOWN = 8;
const WEEKS_AVERAGED = 4;
const HIGH_WINDOW = 0.9;
export const SPEND_DAYS = 30;

export interface SubRun {
  repo: string;
  taskType: string;
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  issueNumber?: number;
  prNumber?: number;
  portalRequest?: number;
}

export interface SubscriptionInput {
  account: string;
  plan: AccountPlan;
  repos: string[];
  history: UsageMeasurement[];
  // This account's runs, any age the view read.
  runs: SubRun[];
  // What Métricas read from GitHub for the account's repos, for the cost of
  // each result.
  repoData: RepoData[];
  now: number;
}

interface Point { at: number; u: number }
interface Week { start: number; reset: number; points: Point[]; fiveHour: Array<{ at: number; u: number; reset: number }>; limitHits: number[] }

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits;

// The measurements grouped by weekly window, oldest first.
export function weeksOf(history: UsageMeasurement[]): Week[] {
  const weeks: Week[] = [];
  const limitHits: number[] = [];
  const sorted = [...history].sort((a, b) => t(a.at) - t(b.at));
  for (const m of sorted) {
    const at = t(m.at);
    if (!Number.isFinite(at)) continue;
    if (m.limitHit) {
      limitHits.push(at);
      continue;
    }
    if (!m.sevenDay) continue;
    const reset = t(m.sevenDay.resetsAt);
    if (!Number.isFinite(reset)) continue;
    let week = weeks.find((w) => Math.abs(w.reset - reset) <= SAME_WEEK_MS);
    if (!week) {
      week = { start: reset - WEEK, reset, points: [], fiveHour: [], limitHits: [] };
      weeks.push(week);
    }
    week.points.push({ at, u: m.sevenDay.utilization });
    if (m.fiveHour) week.fiveHour.push({ at, u: m.fiveHour.utilization, reset: t(m.fiveHour.resetsAt) });
  }
  // Each time the limit was hit, in the week whose window it falls in.
  for (const at of limitHits) weeks.find((w) => at >= w.start && at < w.reset)?.limitHits.push(at);
  return weeks.sort((a, b) => a.reset - b.reset);
}

// What ronin spent between two instants: each run's cost spread evenly over
// its duration. A run without a cost (still going, cut) adds nothing.
export function spentBetween(runs: SubRun[], from: number, to: number): number {
  let usd = 0;
  for (const run of runs) {
    if (typeof run.costUsd !== 'number' || !run.costUsd) continue;
    const start = t(run.startedAt);
    const end = t(run.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) {
      if (end > from && end <= to) usd += run.costUsd;
      continue;
    }
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) usd += run.costUsd * (overlap / (end - start));
  }
  return usd;
}

// Each step of a week: from the window's start (at 0) to the first
// measurement, then from each one to the next.
function steps(week: Week): Array<{ from: number; to: number; rise: number }> {
  const out: Array<{ from: number; to: number; rise: number }> = [];
  let prev: Point = { at: week.start, u: 0 };
  for (const p of week.points) {
    out.push({ from: prev.at, to: p.at, rise: Math.max(0, p.u - prev.u) });
    if (p.u >= prev.u) prev = p;
  }
  return out;
}

// How much quota (fraction of the week) each dollar of ronin moves: a low
// percentile over the last weeks' intervals, each merged until ronin spent
// at least MIN_INTERVAL_USD in it. Null until there are enough.
export function calibrate(weeks: Week[], runs: SubRun[], now: number): { perUsd: number | null; intervals: number } {
  const ratios: number[] = [];
  for (const week of weeks) {
    if (week.reset < now - CALIBRATION_DAYS * DAY) continue;
    let rise = 0;
    let usd = 0;
    for (const step of steps(week)) {
      // The first step of a week whose history starts mid-week holds use from
      // before ronin measured anything: it can't tell who did it.
      if (step.from === week.start && week.points[0].at - week.start > DAY) continue;
      rise += step.rise;
      usd += spentBetween(runs, step.from, step.to);
      if (usd >= MIN_INTERVAL_USD) {
        ratios.push(rise / usd);
        rise = 0;
        usd = 0;
      }
    }
  }
  return { perUsd: ratios.length >= MIN_CALIBRATION_INTERVALS ? percentile(ratios, CALIBRATION_PERCENTILE) : null, intervals: ratios.length };
}

// A week's use, step by step: the total, and ronin's estimated share.
function split(week: Week, runs: SubRun[], perUsd: number | null) {
  let used = 0;
  let ronin = 0;
  const series: Array<{ at: number; used: number; ronin: number | null }> = [];
  for (const step of steps(week)) {
    used += step.rise;
    if (perUsd !== null) ronin += Math.min(step.rise, perUsd * spentBetween(runs, step.from, step.to));
    series.push({ at: step.to, used, ronin: perUsd === null ? null : ronin });
  }
  return { used, ronin: perUsd === null ? null : ronin, series };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function computeSubscription(input: SubscriptionInput) {
  const { now, runs, plan } = input;
  const weeks = weeksOf(input.history);
  const calibration = calibrate(weeks, runs, now);
  const perUsd = calibration.perUsd;
  const lastMeasuredAt = input.history.reduce<string | null>((last, m) => (!last || t(m.at) > t(last) ? m.at : last), null);

  const closed = weeks.filter((w) => w.reset <= now);
  const current = weeks.find((w) => w.reset > now && w.start <= now) ?? null;

  const weekly = closed.slice(-WEEKS_SHOWN).map((w) => {
    const s = split(w, runs, perUsd);
    const close = Math.max(...w.points.map((p) => p.u));
    const ronin = s.ronin === null ? null : Math.min(s.ronin, close);
    return {
      start: iso(w.start),
      resetsAt: iso(w.reset),
      close: round(close),
      ronin: ronin === null ? null : round(ronin),
      others: ronin === null ? null : round(close - ronin),
      unused: round(Math.max(0, 1 - close)),
      lastMeasuredAt: iso(w.points.at(-1)!.at),
      limitHits: w.limitHits.length,
    };
  });
  const averaged = weekly.slice(-WEEKS_AVERAGED);

  let week = null;
  if (current) {
    const s = split(current, runs, perUsd);
    const last = current.points.at(-1)!;
    // The pace of the last 48 h, from the measurement closest before then
    // (or the window's start, at 0).
    const before = [...current.points].reverse().find((p) => p.at <= last.at - PROJECTION_MS) ?? { at: current.start, u: 0 };
    const rate = last.at > before.at ? Math.max(0, (last.u - before.u) / (last.at - before.at)) : 0;
    const projected = last.u + rate * (current.reset - last.at);
    const exhaustsAt = last.u >= 1 ? last.at : rate > 0 && projected >= 1 ? last.at + (1 - last.u) / rate : null;
    const fiveHour = new Map<number, number>();
    for (const f of current.fiveHour) {
      const key = [...fiveHour.keys()].find((k) => Math.abs(k - f.reset) <= SAME_WINDOW_MS) ?? f.reset;
      fiveHour.set(key, Math.max(fiveHour.get(key) ?? 0, f.u));
    }
    const ronin = s.ronin === null ? null : Math.min(s.ronin, last.u);
    week = {
      start: iso(current.start),
      resetsAt: iso(current.reset),
      used: round(last.u),
      ronin: ronin === null ? null : round(ronin),
      others: ronin === null ? null : round(last.u - ronin),
      measuredAt: iso(last.at),
      series: s.series.map((p) => ({ at: iso(p.at), used: round(p.used), ronin: p.ronin === null ? null : round(Math.min(p.ronin, p.used)) })),
      projection: { close: round(projected), exhaustsAt: exhaustsAt === null ? null : iso(exhaustsAt), ratePerDay: round(rate * DAY) },
      fiveHour: { windows: fiveHour.size, over90: [...fiveHour.values()].filter((u) => u >= HIGH_WINDOW).length, limitHits: current.limitHits.length },
    };
  }

  // What ronin spent in the last SPEND_DAYS, by task and by repo.
  const since = now - SPEND_DAYS * DAY;
  const recent = runs.filter((r) => t(r.startedAt) >= since && typeof r.costUsd === 'number');
  const equivUsd = recent.reduce((sum, r) => sum + r.costUsd!, 0);
  const group = (key: (r: SubRun) => string) => {
    const by = new Map<string, { usd: number; runs: number }>();
    for (const r of recent) {
      const g = by.get(key(r)) ?? { usd: 0, runs: 0 };
      g.usd += r.costUsd!;
      g.runs += 1;
      by.set(key(r), g);
    }
    return [...by].map(([k, g]) => ({ key: k, usd: round(g.usd, 2), runs: g.runs })).sort((a, b) => b.usd - a.usd);
  };

  return {
    account: input.account,
    plan,
    repos: input.repos,
    lastMeasuredAt,
    calibration: { perUsd: perUsd === null ? null : round(perUsd, 6), intervals: calibration.intervals },
    week,
    weeks: weekly,
    utilization: averaged.length ? { average: round(averaged.reduce((sum, w) => sum + w.close, 0) / averaged.length), weeks: averaged.length } : null,
    value: { days: SPEND_DAYS, equivUsd: round(equivUsd, 2), priceUsd: plan.priceUsd, ratio: plan.priceUsd ? round(equivUsd / plan.priceUsd, 2) : null },
    spend: { days: SPEND_DAYS, byTask: group((r) => r.taskType), byRepo: group((r) => r.repo) },
    perResult: perResult(input.repoData, runs, since, now),
  };
}

// What each result cost ronin, in API dollars, over the results of the last
// SPEND_DAYS that ronin worked on: an issue resolved counts its runs and
// those of the PRs that close it (with their reviews); a merged PR, its own
// and those of the issues it closes; a portal request, its own. Failed runs
// count too: they were spent on it.
export function perResult(repoData: RepoData[], runs: SubRun[], since: number, now: number) {
  const priced = runs.filter((r) => typeof r.costUsd === 'number');
  const cost = (repo: string, issues: number[], prs: number[]) => priced
    .filter((r) => r.repo === repo && ((r.issueNumber !== undefined && issues.includes(r.issueNumber)) || (r.prNumber !== undefined && prs.includes(r.prNumber))))
    .reduce((sum, r) => sum + r.costUsd!, 0);
  const average = (costs: number[]) => {
    const worked = costs.filter((c) => c > 0);
    return { count: worked.length, avgUsd: worked.length ? round(worked.reduce((a, b) => a + b, 0) / worked.length, 2) : null };
  };
  const issueCosts: number[] = [];
  const prCosts: number[] = [];
  for (const data of repoData) {
    const prs = Object.values(data.prs);
    for (const issue of Object.values(data.issues)) {
      const closed = t(issue.closedAt ?? undefined);
      if (issue.reason !== 'completed' || !(closed >= since && closed < now)) continue;
      issueCosts.push(cost(data.repo, [issue.number], prs.filter((p) => p.closes.includes(issue.number)).map((p) => p.number)));
    }
    for (const pr of prs) {
      const merged = t(pr.mergedAt ?? undefined);
      if (!(merged >= since && merged < now)) continue;
      prCosts.push(cost(data.repo, pr.closes, [pr.number]));
    }
  }
  const requests = new Map<string, { first: number; usd: number }>();
  for (const r of priced) {
    if (r.portalRequest === undefined) continue;
    const key = `${r.repo}#${r.portalRequest}`;
    const entry = requests.get(key) ?? { first: Infinity, usd: 0 };
    entry.first = Math.min(entry.first, t(r.startedAt));
    entry.usd += r.costUsd!;
    requests.set(key, entry);
  }
  return {
    days: SPEND_DAYS,
    issue: average(issueCosts),
    pr: average(prCosts),
    portal: average([...requests.values()].filter((r) => r.first >= since).map((r) => r.usd)),
  };
}

export type Subscription = ReturnType<typeof computeSubscription>;
