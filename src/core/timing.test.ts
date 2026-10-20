import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUCKETS, currentMeasurement, measure, percentile, routeOf, RouteTimings, serverTiming, timed, timingsPath, writeTimings } from './timing.js';
import { localDay } from './run-files.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('measuring', () => {
  it('adds each span to the measurement it runs in, however deep and however many at once', async () => {
    const spans = await measure(async (m) => {
      await timed('github', () => wait(5));
      await Promise.all([timed('github', () => wait(5)), (async () => timed('db', () => wait(1)))()]);
      expect(currentMeasurement()).toBe(m);
      return m.spans;
    });
    expect(spans.get('github')).toMatchObject({ count: 2 });
    expect(spans.get('github')!.ms).toBeGreaterThanOrEqual(8);
    expect(spans.get('db')).toMatchObject({ count: 1 });
  });

  it('keeps two measurements apart, and outside of one only runs what it is given', async () => {
    const [a, b] = await Promise.all([
      measure(async (m) => { await timed('github', () => wait(1)); return m.spans.get('github')!.count; }),
      measure(async (m) => { await timed('github', () => wait(1)); await timed('github', () => wait(1)); return m.spans.get('github')!.count; }),
    ]);
    expect([a, b]).toEqual([1, 2]);
    expect(await timed('github', async () => 'ok')).toBe('ok');
    expect(currentMeasurement()).toBeUndefined();
  });

  it('counts a span that throws, and lets the error through', async () => {
    await measure(async (m) => {
      await expect(timed('github', async () => { throw new Error('caído'); })).rejects.toThrow('caído');
      expect(m.spans.get('github')?.count).toBe(1);
    });
  });

  it('writes the Server-Timing header with the total and each span', () => {
    const header = serverTiming({ start: 100, spans: new Map([['github', { ms: 41.26, count: 3 }]]) }, 350);
    expect(header).toBe('total;dur=250, github;dur=41.3;desc="3"');
  });
});

describe('the routes', () => {
  it('keeps the shape of a route, not its numbers, repos or ids', () => {
    expect(routeOf('/api/portal/requests/26/interview')).toBe('/api/portal/requests/:n/interview');
    expect(routeOf('/api/items/acme%2Fapp%23925/detail')).toBe('/api/items/:id/detail');
    expect(routeOf('/api/runs/20261019T214543-portal-request-p25-7d90')).toBe('/api/runs/:id');
    expect(routeOf('/api/pedidos/9/img/1-1.png')).toBe('/api/pedidos/:n/img/:id');
    expect(routeOf('/api/snapshot')).toBe('/api/snapshot');
  });

  it('sums each route up by window, with its buckets, errors and GitHub time, and starts over after a flush', () => {
    const t = new RouteTimings();
    const github = new Map([['github', { ms: 120, count: 2 }]]);
    t.record({ listener: 'tablero', method: 'GET', route: '/api/snapshot', status: 200, ms: 40, spans: new Map() });
    t.record({ listener: 'tablero', method: 'GET', route: '/api/snapshot', status: 500, ms: 900, spans: github });
    t.record({ listener: 'público', method: 'GET', route: '/api/portal/me', status: 401, ms: 3, spans: new Map() });
    const [snapshot, me] = t.flush(new Date('2026-10-20T10:10:00Z'));
    expect(snapshot).toMatchObject({ listener: 'tablero', route: '/api/snapshot', count: 2, errors: 1, totalMs: 940, maxMs: 900, githubMs: 120, githubCount: 2, to: '2026-10-20T10:10:00.000Z' });
    expect(snapshot.buckets).toEqual([0, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(me).toMatchObject({ count: 1, buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(t.flush()).toEqual([]);
  });

  it('appends the windows to the day file, and writes nothing when there is nothing', () => {
    const t = new RouteTimings();
    t.record({ listener: 'tablero', method: 'GET', route: '/api/today', status: 200, ms: 12, spans: new Map() });
    writeTimings([]);
    writeTimings(t.flush());
    const lines = readFileSync(timingsPath(localDay(new Date())), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ route: '/api/today', count: 1 });
  });

  it('reads a percentile off the buckets as the upper bound of the bucket it falls in', () => {
    const buckets = BUCKETS.map(() => 0).concat(0);
    expect(percentile(buckets, 0.5)).toBeNull();
    buckets[0] = 8; buckets[4] = 1; buckets[10] = 1;
    expect(percentile(buckets, 0.5)).toBe(25);
    expect(percentile(buckets, 0.9)).toBe(500);
    expect(percentile(buckets, 0.99)).toBe(Infinity);
  });
});
