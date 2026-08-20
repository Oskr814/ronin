import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let localStatePath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'localStatePath' ? localStatePath : undefined) }),
}));

const { incrementChecksPendingCount, resetChecksPendingCount, withLocalStateLock, readLocalState } = await import('./local-state.js');
const { withActiveRepo } = await import('./repo-context.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-local-state-test-'));
  localStatePath = join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function withRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return withActiveRepo({ productRepo: repo, productRepoPath: '/tmp/unused' }, fn);
}

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

describe('incrementChecksPendingCount — concurrent calls', () => {
  it('never loses an update under concurrent increments', async () => {
    await withRepo('owner/repo-a', async () => {
      await Promise.all(Array.from({ length: 20 }, () => incrementChecksPendingCount(229)));
      const state = await readLocalState();
      expect(state.checksPendingCounts['229']).toBe(20);
    });
  });

  it('a concurrent reset does not clobber an in-flight increment', async () => {
    await withRepo('owner/repo-a', async () => {
      await Promise.all([
        incrementChecksPendingCount(229),
        incrementChecksPendingCount(229),
        resetChecksPendingCount(229),
        incrementChecksPendingCount(229),
      ]);

      const raw = await readFile(join(dir, 'state.json.owner-repo-a.json'), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});

describe('per-repo namespacing', () => {
  it('keeps checksPendingCounts separate between two repos', async () => {
    await withRepo('owner/repo-a', () => incrementChecksPendingCount(229));

    const stateA = await withRepo('owner/repo-a', readLocalState);
    const stateB = await withRepo('owner/repo-b', readLocalState);

    expect(stateA.checksPendingCounts['229']).toBe(1);
    expect(stateB.checksPendingCounts['229']).toBeUndefined();
  });
});
