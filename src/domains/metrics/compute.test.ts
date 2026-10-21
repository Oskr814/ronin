import { describe, it, expect } from 'vitest';
import { buckets, computeMetrics, issueKind, median, percentile } from './compute.js';
import type { MIssue, MPr, RepoData } from './collect.js';
import type { BlockEvent } from './blocks.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const issue = (number: number, over: Partial<MIssue> = {}): MIssue => ({
  number, title: `issue ${number}`, author: 'ana-dev', createdAt: ago(40 * DAY), updatedAt: ago(DAY), closedAt: null, reason: null,
  assignees: [], labels: [], reopenedAt: [], blockedAt: [], ...over,
});
const done = (number: number, openedDaysAgo: number, closedDaysAgo: number, over: Partial<MIssue> = {}) =>
  issue(number, { createdAt: ago(openedDaysAgo * DAY), closedAt: ago(closedDaysAgo * DAY), updatedAt: ago(closedDaysAgo * DAY), reason: 'completed', ...over });
const pr = (number: number, over: Partial<MPr> = {}): MPr => ({
  number, title: `PR ${number}`, author: 'ana-dev', createdAt: ago(5 * DAY), updatedAt: ago(DAY), mergedAt: null, closedAt: null, draft: false,
  readyAt: null, requests: [], reviews: [], attempts: 0, closes: [], ...over,
});
const repo = (issues: MIssue[], prs: MPr[] = [], releases: RepoData['releases'] = [], name = 'acme/tienda'): RepoData => ({
  repo: name, syncedAt: ago(0), issues: Object.fromEntries(issues.map((i) => [i.number, i])), prs: Object.fromEntries(prs.map((p) => [p.number, p])), releases,
});
const run = (repos: RepoData[], days: 7 | 30 | 90 = 30, blocks: BlockEvent[] = []) => computeMetrics({ repos, blocks, ronin: 'ronin-agent', days, now: NOW });

describe('median and percentile', () => {
  it('take the middle, and the value under which p of them fall', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

describe('buckets', () => {
  it('are days for 7, weeks otherwise, the last one ending now', () => {
    expect(buckets(7, NOW)).toHaveLength(7);
    expect(buckets(30, NOW)).toHaveLength(8);
    expect(buckets(90, NOW)).toHaveLength(13);
    const last = buckets(30, NOW).at(-1)!;
    expect(last).toEqual({ a: NOW - 7 * DAY, b: NOW });
  });
});

describe('issueKind', () => {
  it('reads the usual labels', () => {
    expect(issueKind(['bug'])).toBe('bug');
    expect(issueKind(['Bug: pagos'])).toBe('bug');
    expect(issueKind(['enhancement'])).toBe('feature');
    expect(issueKind(['mejora'])).toBe('feature');
    expect(issueKind(['docs'])).toBe('otro');
  });
});

describe('totals', () => {
  it('resolves only what closed as completed in the period, and counts the not planned apart', () => {
    const m = run([repo([
      done(1, 10, 8), // 2 days
      done(2, 12, 6), // 6 days
      done(3, 50, 40), // before the period
      issue(4, { createdAt: ago(20 * DAY), closedAt: ago(2 * DAY), reason: 'not_planned' }),
      issue(5, { createdAt: ago(3 * DAY) }),
    ])]);
    expect(m.current.resolved).toBe(2);
    expect(m.current.resolutionMedian).toBe(4 * DAY);
    expect(m.current.opened).toBe(4);
    expect(m.current.backlog).toBe(1);
    expect(m.health.notPlanned).toBe(1);
    expect(m.previous.resolved).toBe(1);
  });

  it('counts the backlog as it stood at the end of each bar', () => {
    const m = run([repo([done(1, 20, 3), issue(2, { createdAt: ago(10 * DAY) })])]);
    const lastTwo = m.series.slice(-2).map((s) => s.backlog);
    expect(lastTwo).toEqual([2, 1]);
  });

  it('times the first review from the request, but not before the PR left draft', () => {
    const m = run([repo([], [
      pr(10, { createdAt: ago(5 * DAY), requests: [{ reviewer: 'beto-dev', at: ago(4 * DAY) }], reviews: [{ author: 'beto-dev', state: 'APPROVED', at: ago(4 * DAY - 2 * HOUR) }] }),
      pr(11, { createdAt: ago(5 * DAY), requests: [{ reviewer: 'beto-dev', at: ago(5 * DAY) }], readyAt: ago(3 * DAY), reviews: [{ author: 'beto-dev', state: 'APPROVED', at: ago(3 * DAY - 4 * HOUR) }] }),
      // The author's own comment isn't a review.
      pr(12, { createdAt: ago(5 * DAY), reviews: [{ author: 'ana-dev', state: 'COMMENTED', at: ago(4 * DAY) }] }),
    ])]);
    expect(m.current.firstReviewMedian).toBe(3 * HOUR);
  });
});

describe('people', () => {
  const data = () => [repo([
    done(1, 6, 2, { assignees: ['ana-dev'] }),
    done(2, 10, 4, { assignees: ['ana-dev', 'beto-dev'] }),
    issue(3, { assignees: ['ana-dev'], updatedAt: ago(20 * DAY) }),
    issue(4, { assignees: ['ronin-agent'], labels: ['ronin:blocked'] }),
    done(5, 3, 1, { assignees: ['ronin-agent'] }),
    issue(6, { assignees: ['dependabot[bot]'] }),
  ], [
    pr(20, { author: 'ana-dev', mergedAt: ago(2 * DAY), reviews: [{ author: 'beto-dev', state: 'CHANGES_REQUESTED', at: ago(4 * DAY) }, { author: 'beto-dev', state: 'APPROVED', at: ago(3 * DAY) }], requests: [{ reviewer: 'beto-dev', at: ago(4 * DAY + 6 * HOUR) }] }),
    pr(21, { author: 'ronin-agent', mergedAt: ago(DAY), reviews: [{ author: 'ana-dev', state: 'APPROVED', at: ago(2 * DAY) }] }),
    // Waiting on caro-dev for 3 days.
    pr(22, { author: 'beto-dev', requests: [{ reviewer: 'caro-dev', at: ago(3 * DAY) }] }),
  ])];

  it('credits every assignee, and leaves bots other than ronin out', () => {
    const people = run(data()).people;
    expect(people.map((p) => p.login).sort()).toEqual(['ana-dev', 'beto-dev', 'caro-dev', 'ronin-agent']);
    const ana = people.find((p) => p.login === 'ana-dev')!;
    expect(ana).toMatchObject({ resolved: 2, open: 1, quiet: 1, merged: 1, reviewRounds: 1, reviews: 1 });
    expect(ana.resolutionMedian).toBe(5 * DAY);
    expect(ana.openList.map((i) => i.number)).toEqual([3]);
  });

  it('times how long someone takes to review from when they were asked', () => {
    const beto = run(data()).people.find((p) => p.login === 'beto-dev')!;
    expect(beto.reviews).toBe(1);
    expect(beto.reviewWaitMedian).toBe(6 * HOUR);
    expect(run(data()).people.find((p) => p.login === 'caro-dev')!.waitingOnThem).toBe(1);
  });

  it("gives ronin its own row, without the reviewer's columns", () => {
    const ronin = run(data()).people.find((p) => p.login === 'ronin-agent')!;
    expect(ronin).toMatchObject({ agent: true, resolved: 1, open: 1, reviews: null, waitingOnThem: null });
    expect(ronin.openList[0]).toMatchObject({ number: 4, blocked: true });
  });

  it('lists the PRs waiting for a review longer than 2 days, with who owes it', () => {
    const { health } = run(data());
    expect(health.waitingReview).toEqual([expect.objectContaining({ number: 22, reviewers: ['caro-dev'] })]);
    expect(health.firstTry).toBe(0.5);
  });
});

describe('health', () => {
  it('sorts the backlog by age, and counts the unassigned and the stale', () => {
    const { health } = run([repo([
      issue(1, { createdAt: ago(2 * DAY) }),
      issue(2, { createdAt: ago(10 * DAY), assignees: ['ana-dev'], updatedAt: ago(40 * DAY) }),
      issue(3, { createdAt: ago(100 * DAY), assignees: ['ana-dev'] }),
      done(4, 5, 1, { reopenedAt: [ago(3 * DAY)] }),
    ])]);
    expect(health.ages.map((a) => a.count)).toEqual([1, 1, 0, 1]);
    expect(health.unassigned).toBe(1);
    expect(health.stale).toBe(1);
    expect(health.reopened).toBe(1);
  });
});

describe('deploys', () => {
  it('counts the releases and times each merged PR to the first one after it', () => {
    const m = run([repo([], [
      pr(1, { mergedAt: ago(10 * DAY) }),
      pr(2, { mergedAt: ago(9 * DAY) }),
    ], [
      { tag: 'v1.1', publishedAt: ago(8 * DAY), prerelease: false },
      { tag: 'v1.2-rc', publishedAt: ago(9.5 * DAY), prerelease: true },
      { tag: 'v1.0', publishedAt: ago(50 * DAY), prerelease: false },
    ])]);
    expect(m.deploys).toMatchObject({ count: 1, previous: 1, leadMedian: 1.5 * DAY });
  });

  it('is null when no repo publishes releases', () => {
    expect(run([repo([])]).deploys).toBeNull();
  });
});

describe('ronin', () => {
  it('measures its share, how much it finished without blocking, and why it blocked', () => {
    const m = run([repo([
      done(1, 5, 1, { assignees: ['ronin-agent'] }),
      done(2, 5, 1, { assignees: ['ronin-agent'], blockedAt: [ago(3 * DAY)] }),
      done(3, 9, 1, { assignees: ['ana-dev'] }),
      issue(4, { assignees: ['ronin-agent'], blockedAt: [ago(2 * DAY)] }),
    ], [
      pr(10, { author: 'ronin-agent', mergedAt: ago(DAY), attempts: 2, reviews: [{ author: 'ana-dev', state: 'CHANGES_REQUESTED', at: ago(2 * DAY) }] }),
      pr(11, { author: 'ronin-agent', mergedAt: ago(DAY) }),
    ])], 30, [
      // Recorded: the one on #2 (the label's twin) and one on another repo.
      { repo: 'acme/tienda', item: 2, reason: 'Feedback de review sin converger tras el límite de intentos', at: ago(3 * DAY - 60_000) },
      { repo: 'acme/otro', item: 9, reason: 'ronin necesita información para seguir con este issue', at: ago(DAY) },
    ]);
    expect(m.ronin.share).toBeCloseTo(2 / 3);
    expect(m.ronin.unblocked).toBe(0.5);
    expect(m.ronin.firstTry).toBe(0.5);
    expect(m.ronin.attempts).toBe(1);
    expect(m.ronin.blocks).toBe(2);
    expect(m.ronin.blockReasons).toEqual([{ reason: 'Review que no converge', count: 1 }, { reason: 'Sin motivo registrado', count: 1 }]);
  });
});
