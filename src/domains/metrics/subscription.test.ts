import { describe, it, expect } from 'vitest';
import type { UsageMeasurement } from '../../core/claude-usage.js';
import type { AccountPlan } from '../../core/claude-plans.js';
import type { RepoData } from './collect.js';
import { calibrate, computeSubscription, perResult, spentBetween, weeksOf, type SubRun } from './subscription.js';

const H = 3_600_000;
const D = 24 * H;
// The week in course resets on Wednesday the 21st; the one before on the 14th.
const RESET = Date.parse('2026-10-21T00:00:00Z');
const START = RESET - 7 * D;
const iso = (ms: number) => new Date(ms).toISOString();
const MAX5: AccountPlan = { plan: 'max5', name: 'Max 5×', priceUsd: 100, source: 'defecto' };

const m = (at: number, week: number, opts: { reset?: number; five?: number; fiveReset?: number } = {}): UsageMeasurement => ({
  at: iso(at),
  sevenDay: { utilization: week, resetsAt: iso(opts.reset ?? RESET) },
  ...(opts.five !== undefined ? { fiveHour: { utilization: opts.five, resetsAt: iso(opts.fiveReset ?? at + 2 * H) } } : {}),
});
const run = (start: number, hours: number, costUsd: number, extra: Partial<SubRun> = {}): SubRun => ({ repo: 'acme/app', taskType: 'fix-issue', startedAt: iso(start), endedAt: iso(start + hours * H), costUsd, ...extra });

// A week where ronin alone moves 1 % per dollar, and someone else adds
// 5 % in two of the intervals.
function scenario() {
  const history: UsageMeasurement[] = [];
  const runs: SubRun[] = [];
  let u = 0;
  for (let i = 0; i < 10; i++) {
    const at = START + (i + 1) * 12 * H;
    runs.push(run(at - 10 * H, 2, 2, { issueNumber: 100 + i }));
    u += 0.02 + (i === 3 || i === 6 ? 0.05 : 0);
    history.push(m(at, Math.round(u * 100) / 100));
  }
  return { history, runs };
}

describe('weeksOf', () => {
  it('groups by weekly window, even with a resetsAt a little off, and puts each limit hit in its week', () => {
    const weeks = weeksOf([
      m(START - 2 * D, 0.5, { reset: START }),
      m(START + D, 0.1),
      m(START + 2 * D, 0.2, { reset: RESET + 20 * 60_000 }),
      { at: iso(START + 3 * D), limitHit: true },
    ]);
    expect(weeks.map((w) => [iso(w.reset), w.points.length, w.limitHits.length])).toEqual([[iso(START), 1, 0], [iso(RESET), 2, 1]]);
  });
});

describe('spentBetween', () => {
  it('spreads each run\'s cost over its duration, and skips one without a cost', () => {
    const runs = [run(0, 4, 8), { ...run(0, 1, 0), costUsd: undefined }, { repo: 'a', taskType: 'x', startedAt: iso(0) }];
    expect(spentBetween(runs, 1 * H, 2 * H)).toBe(2);
    expect(spentBetween(runs, -10 * H, 10 * H)).toBe(8);
    expect(spentBetween(runs, 5 * H, 6 * H)).toBe(0);
  });
});

describe('calibrate', () => {
  it('takes a low percentile of quota per dollar: others using the account only push it up', () => {
    const { history, runs } = scenario();
    const out = calibrate(weeksOf(history), runs, START + 6 * D);
    expect(out.intervals).toBe(10);
    expect(out.perUsd).toBeCloseTo(0.01, 5);
  });

  it('has no rate until there are enough intervals with ronin spending', () => {
    const out = calibrate(weeksOf([m(START + D, 0.1), m(START + 2 * D, 0.2)]), [run(START + D + H, 1, 3)], START + 3 * D);
    expect(out).toEqual({ perUsd: null, intervals: 1 });
  });
});

describe('computeSubscription', () => {
  it('splits the week in course into ronin and others, and projects the close at the pace of the last 48 h', () => {
    const { history, runs } = scenario();
    const now = START + 5 * D + H;
    const out = computeSubscription({ account: 'acme', plan: MAX5, repos: ['acme/app'], history: history.filter((x) => Date.parse(x.at) <= now), runs, repoData: [], now });
    const week = out.week!;
    // Ten measurements, one every 12 h: 10 × 2 % from ronin, plus 5 % twice from others.
    expect(week.used).toBe(0.3);
    expect(week.ronin).toBeCloseTo(0.2, 5);
    expect(week.others).toBeCloseTo(0.1, 5);
    expect(week.series).toHaveLength(10);
    // From 0.17 (48 h before the last one, at day 5) to 0.30, and two days left.
    expect(week.projection.ratePerDay).toBeCloseTo(0.065, 4);
    expect(week.projection.close).toBeCloseTo(0.43, 4);
    expect(week.projection.exhaustsAt).toBeNull();
    expect(out.lastMeasuredAt).toBe(iso(START + 5 * D));
  });

  it('says what day the quota runs out at this pace', () => {
    const now = START + 3 * D;
    const out = computeSubscription({ account: 'acme', plan: MAX5, repos: [], history: [m(START + D, 0.2), m(START + 3 * D, 0.6)], runs: [], repoData: [], now });
    expect(out.week!.projection.exhaustsAt).toBe(iso(START + 5 * D));
    expect(out.week!.ronin).toBeNull();
  });

  it('closes each past week at its highest measurement, and averages the last four', () => {
    const history: UsageMeasurement[] = [];
    const closes = [0.3, 0.5, 0.7, 0.9, 1];
    closes.forEach((close, i) => {
      const reset = RESET - (closes.length - i) * 7 * D;
      history.push(m(reset - 3 * D, close / 2, { reset }), m(reset - D, close, { reset }));
    });
    history.push({ at: iso(RESET - 7 * D - 2 * H), limitHit: true });
    const out = computeSubscription({ account: 'acme', plan: MAX5, repos: [], history, runs: [], repoData: [], now: RESET - 2 * D });
    expect(out.weeks.map((w) => [w.close, w.unused])).toEqual([[0.3, 0.7], [0.5, 0.5], [0.7, 0.3], [0.9, 0.1], [1, 0]]);
    expect(out.weeks.at(-1)!.limitHits).toBe(1);
    expect(out.utilization).toEqual({ average: 0.775, weeks: 4 });
    expect(out.week).toBeNull();
  });

  it('counts the 5-hour windows of this week that went over 90 %', () => {
    const w1 = START + D;
    const w2 = START + 2 * D;
    const history = [m(w1 - H, 0.1, { five: 0.5, fiveReset: w1 }), m(w1 - 1000, 0.15, { five: 0.95, fiveReset: w1 + 60_000 }), m(w2 - H, 0.2, { five: 0.4, fiveReset: w2 })];
    const out = computeSubscription({ account: 'acme', plan: MAX5, repos: [], history, runs: [], repoData: [], now: w2 });
    expect(out.week!.fiveHour).toEqual({ windows: 2, over90: 1, limitHits: 0 });
  });

  it('compares what ronin\'s runs of the last 30 days would cost on the API with the plan, and groups them by task and repo', () => {
    const now = RESET;
    const runs = [run(now - D, 1, 120, { taskType: 'fix-issue' }), run(now - 2 * D, 1, 30, { taskType: 'plan', repo: 'acme/web' }), run(now - 40 * D, 1, 500)];
    const out = computeSubscription({ account: 'acme', plan: { ...MAX5, plan: 'pro', name: 'Pro', priceUsd: 20 }, repos: [], history: [], runs, repoData: [], now });
    expect(out.value).toEqual({ days: 30, equivUsd: 150, priceUsd: 20, ratio: 7.5 });
    expect(out.spend.byTask).toEqual([{ key: 'fix-issue', usd: 120, runs: 1 }, { key: 'plan', usd: 30, runs: 1 }]);
    expect(out.spend.byRepo.map((g) => g.key)).toEqual(['acme/app', 'acme/web']);
    expect(out.week).toBeNull();
    expect(out.utilization).toBeNull();
  });

  it('has no value ratio for a plan without a price', () => {
    const out = computeSubscription({ account: 'acme', plan: { ...MAX5, plan: 'otro', name: 'Otro', priceUsd: null }, repos: [], history: [], runs: [run(RESET - D, 1, 10)], repoData: [], now: RESET });
    expect(out.value.ratio).toBeNull();
  });
});

describe('perResult', () => {
  const now = RESET;
  const since = now - 30 * D;
  const issue = (number: number, closedAt: number | null, reason: 'completed' | 'not_planned' | null = 'completed') => ({ number, title: '', author: 'x', createdAt: iso(since - D), updatedAt: iso(now), closedAt: closedAt === null ? null : iso(closedAt), reason, assignees: [], labels: [], reopenedAt: [], blockedAt: [] });
  const pr = (number: number, mergedAt: number | null, closes: number[]) => ({ number, title: '', author: 'ronin', createdAt: iso(since), updatedAt: iso(now), mergedAt: mergedAt === null ? null : iso(mergedAt), closedAt: null, draft: false, readyAt: null, requests: [], reviews: [], attempts: 0, closes });
  const data: RepoData = {
    repo: 'acme/app', syncedAt: iso(now), releases: [],
    issues: { 1: issue(1, now - D), 2: issue(2, now - 2 * D), 3: issue(3, now - D, 'not_planned'), 4: issue(4, now - 60 * D), 5: issue(5, now - D) },
    prs: { 10: pr(10, now - D, [1]), 11: pr(11, now - 2 * D, [2]), 12: pr(12, null, [5]) },
  };

  it('adds the runs of an issue, of the PRs that close it and of their reviews, failed ones too', () => {
    const runs = [
      run(now - 3 * D, 1, 4, { issueNumber: 1 }),
      run(now - 2 * D, 1, 2, { prNumber: 10, taskType: 'fix-review' }),
      run(now - 2 * D, 1, 1, { issueNumber: 2 }),
      { ...run(now - 2 * D, 1, 3, { issueNumber: 2 }), taskType: 'fix-issue' },
      run(now - 3 * D, 1, 9, { issueNumber: 3 }),
      run(now - 3 * D, 1, 5, { issueNumber: 1, repo: 'acme/web' }),
    ];
    const out = perResult([data], runs, since, now);
    // Issue 1: 4 + 2; issue 2: 1 + 3. The one not planned, the old one and
    // the one nobody at ronin touched (5) don't count.
    expect(out.issue).toEqual({ count: 2, avgUsd: 5 });
    expect(out.pr).toEqual({ count: 2, avgUsd: 5 });
  });

  it('counts each portal request whose first run is in the period', () => {
    const runs = [
      run(now - 2 * D, 1, 1, { portalRequest: 7, taskType: 'portal-request' }),
      run(now - D, 1, 0.5, { portalRequest: 7, taskType: 'portal-interview' }),
      run(now - 3 * D, 1, 2.5, { portalRequest: 8 }),
      run(now - 40 * D, 1, 4, { portalRequest: 9 }),
      run(now - D, 1, 1, { portalRequest: 9 }),
    ];
    expect(perResult([], runs, since, now).portal).toEqual({ count: 2, avgUsd: 2 });
  });
});
