import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const { ReadCache } = await import('./read-cache.js');

const TTL = 60_000;
// The cache stamps its reads with the real clock: `now` goes from it.
const T = Date.now();
const newCache = () => new ReadCache<{ v: number; error?: string }>({ label: (k) => k, ttlMs: () => TTL, forgetMs: 30 * 60_000, failed: (previous, error) => ({ ...(previous ?? { v: -1 }), error }) });

// A read that answers when told to.
function reads() {
  const pending: Array<(v: number) => void> = [];
  const read = vi.fn(() => new Promise<{ v: number }>((resolve) => pending.push((v) => resolve({ v }))));
  return { read, answer: async (v: number) => { pending.shift()!(v); await new Promise((r) => setTimeout(r, 0)); } };
}

describe('the dashboard\'s read cache (#368)', () => {
  it('waits only for the first read, then serves what it has while it reads again', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const first = cache.get('k', read, { now: T });
    await answer(1);
    expect(await first).toEqual({ v: 1 });
    expect(await cache.get('k', read, { now: T + 1000 })).toEqual({ v: 1 });
    expect(read).toHaveBeenCalledTimes(1);

    // Past the TTL, or a run changed it: the old read, right away, and a new one under way.
    expect(await cache.get('k', read, { now: T + 2 * TTL })).toEqual({ v: 1 });
    expect(read).toHaveBeenCalledTimes(2);
    await answer(2);
    expect(await cache.get('k', read, { now: T + 2 * TTL + 1 })).toEqual({ v: 2 });
  });

  it('after a write the person will look at, reads again at once and makes the next request wait for it', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const first = cache.get('k', read, { tags: ['acme/tienda#7'] });
    await answer(1);
    await first;

    cache.expire('acme/tienda#7', { wait: true });
    expect(read).toHaveBeenCalledTimes(2);
    const next = cache.get('k', read, { tags: ['acme/tienda#7'] });
    expect(read).toHaveBeenCalledTimes(2);
    await answer(2);
    expect(await next).toEqual({ v: 2 });
  });

  it('after a webhook, reads again at once but keeps serving what it has', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const first = cache.get('k', read, { tags: ['acme/tienda'] });
    await answer(1);
    await first;
    cache.expire('acme/tienda');
    expect(read).toHaveBeenCalledTimes(2);
    expect(await cache.get('k', read, { tags: ['acme/tienda'] })).toEqual({ v: 1 });
    await answer(2);
    expect(await cache.get('k', read, { tags: ['acme/tienda'] })).toEqual({ v: 2 });
  });

  it('never keeps a read that started before the write, even if it ends after it', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const first = cache.get('k', read, { tags: ['t'], now: T });
    await answer(1);
    await first;
    // A read under way (the TTL ran out), and then a write.
    void cache.get('k', read, { tags: ['t'], now: T + 2 * TTL });
    cache.expire('t', { wait: true });
    expect(read).toHaveBeenCalledTimes(3);
    const next = cache.get('k', read, { tags: ['t'] });
    await answer(2); // the one from before the write
    await answer(3);
    expect(await next).toEqual({ v: 3 });
    expect(await cache.get('k', read, { tags: ['t'] })).toEqual({ v: 3 });
  });

  it('reads once more after a burst of webhooks during a read, not once per webhook', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const first = cache.get('k', read, { tags: ['r'] });
    await answer(1);
    await first;
    cache.expire('r');
    cache.expire('r');
    cache.expire('r');
    expect(read).toHaveBeenCalledTimes(2);
    await answer(2);
    expect(read).toHaveBeenCalledTimes(3);
    await answer(3);
    expect(await cache.get('k', read, { tags: ['r'] })).toEqual({ v: 3 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('only expires what has the tag, and does not read again what nobody is looking at', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const a = cache.get('a', read, { tags: ['r', 'r#1'], now: T });
    await answer(1);
    await a;
    const b = cache.get('b', read, { tags: ['r', 'r#2'], now: T });
    await answer(2);
    await b;
    cache.expire('r#1', { now: T + 1000 });
    expect(read).toHaveBeenCalledTimes(3);
    // Nobody asked for either in a while: a webhook leaves them for their next request.
    await answer(1);
    cache.expire('r', { now: T + 10 * 60_000 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(await cache.get('b', read, { tags: ['r', 'r#2'], now: T + 10 * 60_000 })).toEqual({ v: 2 });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('takes in what a write knows, for everything with the tag', async () => {
    const cache = newCache();
    const { read, answer } = reads();
    const a = cache.get('a', read, { tags: ['r#1'] });
    await answer(1);
    await a;
    cache.update('r#1', (d) => ({ ...d, v: d.v + 10 }));
    cache.update('r#9', () => ({ v: 0 }));
    expect(await cache.get('a', read, { tags: ['r#1'] })).toEqual({ v: 11 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous read with the error when one fails, and stops waiting', async () => {
    const cache = newCache();
    const read = vi.fn().mockResolvedValueOnce({ v: 1 }).mockRejectedValueOnce(new Error('HTTP 502\nmás')).mockResolvedValue({ v: 3 });
    await cache.get('k', read, { tags: ['t'] });
    cache.expire('t', { wait: true });
    expect(await cache.get('k', read, { tags: ['t'] })).toEqual({ v: 1, error: 'HTTP 502' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('fails the request when `failed` throws, without an unhandled rejection from a read in the background', async () => {
    const cache = new ReadCache<{ v: number }>({ label: (k) => k, ttlMs: () => TTL, failed: (previous, _message, error) => { if (previous) return previous; throw error; } });
    await expect(cache.get('k', vi.fn().mockRejectedValue(new Error('HTTP 401')), { tags: ['t'] })).rejects.toThrow('HTTP 401');
    const read = vi.fn().mockResolvedValueOnce({ v: 1 }).mockRejectedValue(new Error('HTTP 502'));
    await cache.get('j', read, { tags: ['u'] });
    cache.expire('u');
    await new Promise((r) => setTimeout(r, 0));
    expect(await cache.get('j', read, { tags: ['u'] })).toEqual({ v: 1 });
  });

  it('forgets what nobody asked for in a while, and drops what it is told to', async () => {
    const cache = newCache();
    const read = vi.fn().mockResolvedValue({ v: 1 });
    await cache.get('a', read, { tags: ['r'], now: T });
    await cache.get('b', read, { tags: ['r'], now: T + 31 * 60_000 });
    expect(cache.has('a')).toBe(false);
    cache.forget('r');
    expect(cache.has('b')).toBe(false);
  });
});
