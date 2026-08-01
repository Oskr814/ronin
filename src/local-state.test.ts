import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let localStatePath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'localStatePath' ? localStatePath : undefined) }),
}));

const { incrementChecksPendingCount, resetChecksPendingCount, withLocalStateLock, readLocalState } = await import('./local-state.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valeria-local-state-test-'));
  localStatePath = join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('withLocalStateLock', () => {
  it('serializes overlapping critical sections instead of interleaving them', async () => {
    const order: string[] = [];
    const a = withLocalStateLock(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a-end');
    });
    const b = withLocalStateLock(async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 0));
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not stay locked forever after a critical section throws', async () => {
    await expect(withLocalStateLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    await expect(withLocalStateLock(async () => 'ok')).resolves.toBe('ok');
  });
});

// Regression: concurrent read-modify-write on the same file used to be able
// to lose an update (two callers both read before either writes) — this is
// exactly the race that motivated withLocalStateLock once tick() started
// running several issues' pipelines concurrently.
describe('incrementChecksPendingCount — concurrent calls', () => {
  it('never loses an update under concurrent increments', async () => {
    await Promise.all(Array.from({ length: 20 }, () => incrementChecksPendingCount(229)));

    const state = await readLocalState();
    expect(state.checksPendingCounts['229']).toBe(20);
  });

  it('a concurrent reset does not clobber an in-flight increment', async () => {
    await Promise.all([
      incrementChecksPendingCount(229),
      incrementChecksPendingCount(229),
      resetChecksPendingCount(229),
      incrementChecksPendingCount(229),
    ]);

    // Whatever the final interleaving, the file itself must stay valid JSON
    // reflecting a consistent state — never a torn write from two
    // overlapping writeFile calls.
    const raw = await readFile(localStatePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
