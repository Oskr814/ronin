import { describe, it, expect } from 'vitest';
import { runWithConcurrency, runJobs } from './concurrency.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('runWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('keeps other items running when one worker rejects', async () => {
    const seen: number[] = [];
    await expect(
      runWithConcurrency([1, 2, 3], 3, async (item) => {
        if (item === 2) throw new Error('boom');
        seen.push(item);
      }),
    ).rejects.toThrow('boom');
    // The two non-throwing lanes still got their own item processed —
    // Promise.all rejecting doesn't retroactively cancel work already done.
    expect(seen.sort()).toEqual([1, 3]);
  });

  it('resolves immediately for an empty list', async () => {
    let called = false;
    await runWithConcurrency([], 2, async () => { called = true; });
    expect(called).toBe(false);
  });

  it('respects concurrency ordering: a slow first item does not block a fast second lane', async () => {
    const order: string[] = [];
    const slow = deferred<void>();
    const items = ['slow', 'fast', 'fast2'];
    const run = runWithConcurrency(items, 2, async (item) => {
      if (item === 'slow') {
        order.push('slow-start');
        await slow.promise;
        order.push('slow-end');
      } else {
        order.push(`${item}-start`);
        order.push(`${item}-end`);
      }
    });
    // Let the microtask queue settle so both initial lanes have started.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toContain('fast-start');
    expect(order).not.toContain('slow-end');
    slow.resolve();
    await run;
    expect(order).toContain('slow-end');
  });
});

describe('runJobs', () => {
  const job = (kind: string, label: string, log: string[], ms = 5) => ({
    kind,
    label,
    run: async () => {
      log.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${label}`);
    },
  });

  it('runs every job once, never more than `limit` at once', async () => {
    let inFlight = 0;
    let max = 0;
    const jobs = [1, 2, 3, 4, 5].map((n) => ({
      kind: n % 2 ? 'a' : 'b',
      label: String(n),
      run: async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    }));
    await runJobs(jobs, 3);
    expect(max).toBe(3);
  });

  it('caps one kind without holding back the others', async () => {
    const log: string[] = [];
    await runJobs([job('review', 'r1', log, 20), job('review', 'r2', log), job('issue', 'i1', log)], 2, { review: 1 });
    // r2 waits for r1; i1 takes the free slot right away instead of queueing behind r2.
    expect(log.slice(0, 2)).toEqual(['start r1', 'start i1']);
    expect(log.indexOf('start r2')).toBeGreaterThan(log.indexOf('end r1'));
  });

  it('keeps a kind capped at 1 in list order', async () => {
    const log: string[] = [];
    await runJobs([job('changelog', 'v1', log, 10), job('changelog', 'v2', log)], 4, { changelog: 1 });
    expect(log).toEqual(['start v1', 'end v1', 'start v2', 'end v2']);
  });

  it('keeps going when a job rejects', async () => {
    const log: string[] = [];
    await runJobs([{ kind: 'a', label: 'boom', run: async () => { throw new Error('boom'); } }, job('a', 'ok', log)], 1);
    expect(log).toEqual(['start ok', 'end ok']);
  });
});
