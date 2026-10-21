import { describe, it, expect } from 'vitest';
import { ms, summarizeRoutes, summarizeTicks, tickMetricsOf } from './timing-report.js';
import type { RouteWindow } from './timing.js';

const window = (over: Partial<RouteWindow>): RouteWindow => ({
  from: '', to: '', listener: 'tablero', method: 'GET', route: '/api/snapshot', count: 0, errors: 0, totalMs: 0, maxMs: 0,
  buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], githubMs: 0, githubCount: 0, ...over,
});

describe('the timings report', () => {
  it('adds the windows of each route up, the heaviest first', () => {
    const [snapshot, me] = summarizeRoutes([
      window({ count: 2, totalMs: 300, maxMs: 200, buckets: [0, 0, 1, 1, 0, 0, 0, 0, 0, 0], githubMs: 100, githubCount: 4 }),
      window({ count: 2, totalMs: 500, maxMs: 450, errors: 1, buckets: [0, 0, 0, 1, 1, 0, 0, 0, 0, 0] }),
      window({ listener: 'público', route: '/api/portal/me', count: 10, totalMs: 50, maxMs: 9, buckets: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    ]);
    expect(snapshot).toMatchObject({ route: '/api/snapshot', count: 4, errors: 1, avgMs: 200, p50: 250, p90: 500, maxMs: 450, githubMs: 25, githubCalls: 1 });
    expect(me).toMatchObject({ route: '/api/portal/me', count: 10, p99: 25 });
  });

  it('reads the tick_complete lines of the tick log, old and new, and sums them up by repo', () => {
    const log = [
      '[2026-10-19T00:00:00.000Z] INFO tick start (commit abc, repo acme/app)',
      '{"event":"tick_complete","ts":"x","durationMs":30000,"repo":"acme/app"}',
      '{"event":"tick_complete","ts":"x","durationMs":40000,"repo":"acme/app","steps":{"assign":2000,"sweeps":9000},"discoveryMs":12000,"jobsMs":3000,"githubMs":25000,"githubCalls":80}',
      '{"event":"event_complete","ts":"x","durationMs":1,"repo":"acme/app"}',
      '{"event":"tick_complete", roto',
    ].join('\n');
    const metrics = tickMetricsOf(log);
    expect(metrics).toHaveLength(2);
    expect(summarizeTicks(metrics)).toEqual([{ repo: 'acme/app', ticks: 2, p50: 40000, p90: 40000, max: 40000, steps: { assign: 2000, sweeps: 9000 }, discoveryMs: 12000, jobsMs: 3000, githubMs: 25000, githubCalls: 80 }]);
  });

  it('writes durations the way people read them', () => {
    expect([ms(null), ms(12.4), ms(2500), ms(Infinity)]).toEqual(['—', '12 ms', '2.5 s', '>10 s']);
  });
});
