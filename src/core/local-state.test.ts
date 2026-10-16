import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let localStatePath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'localStatePath' ? localStatePath : undefined) }),
}));

const { incrementChecksPendingCount, resetChecksPendingCount, withLocalStateLock, readLocalState, getLastReviewedSha, setLastReviewedSha, pruneLastReviewedSha, getLastChangelogRelease, setLastChangelogRelease, getProcessedComments, recordProcessedComment, getBlocks, recordBlock } = await import('./local-state.js');
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

describe('getLastReviewedSha / setLastReviewedSha', () => {
  it('returns undefined when no SHA was ever recorded for that PR', async () => {
    await withRepo('owner/repo-a', async () => {
      expect(await getLastReviewedSha(305)).toBeUndefined();
    });
  });

  it('round-trips a recorded SHA', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastReviewedSha(305, 'abc123');
      expect(await getLastReviewedSha(305)).toBe('abc123');
    });
  });

  it('overwrites a previously recorded SHA for the same PR', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastReviewedSha(305, 'abc123');
      await setLastReviewedSha(305, 'def456');
      expect(await getLastReviewedSha(305)).toBe('def456');
    });
  });

  it('keeps lastReviewedSha separate between two repos', async () => {
    await withRepo('owner/repo-a', () => setLastReviewedSha(305, 'abc123'));

    const shaA = await withRepo('owner/repo-a', () => getLastReviewedSha(305));
    const shaB = await withRepo('owner/repo-b', () => getLastReviewedSha(305));

    expect(shaA).toBe('abc123');
    expect(shaB).toBeUndefined();
  });
});

describe('pruneLastReviewedSha', () => {
  it('drops entries for PRs that are no longer open, keeping the rest', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastReviewedSha(305, 'abc123');
      await setLastReviewedSha(306, 'def456');

      await pruneLastReviewedSha([306]);

      expect(await getLastReviewedSha(305)).toBeUndefined();
      expect(await getLastReviewedSha(306)).toBe('def456');
    });
  });

  it('clears everything when no external PR is open anymore', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastReviewedSha(305, 'abc123');

      await pruneLastReviewedSha([]);

      expect((await readLocalState()).lastReviewedSha).toEqual({});
    });
  });

  it('leaves checksPendingCounts untouched', async () => {
    await withRepo('owner/repo-a', async () => {
      await incrementChecksPendingCount(229);
      await setLastReviewedSha(305, 'abc123');

      await pruneLastReviewedSha([]);

      expect((await readLocalState()).checksPendingCounts['229']).toBe(1);
    });
  });
});

describe('getLastChangelogRelease / setLastChangelogRelease', () => {
  it('returns undefined when nothing was ever recorded', async () => {
    await withRepo('owner/repo-a', async () => {
      expect(await getLastChangelogRelease()).toBeUndefined();
    });
  });

  it('round-trips a recorded release', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastChangelogRelease('v1.13.79-odoo', '2026-09-12T17:06:10Z');
      expect(await getLastChangelogRelease()).toEqual({ tag: 'v1.13.79-odoo', publishedAt: '2026-09-12T17:06:10Z' });
    });
  });

  it('overwrites a previously recorded release', async () => {
    await withRepo('owner/repo-a', async () => {
      await setLastChangelogRelease('v1', '2026-01-01T00:00:00Z');
      await setLastChangelogRelease('v2', '2026-01-02T00:00:00Z');
      expect(await getLastChangelogRelease()).toEqual({ tag: 'v2', publishedAt: '2026-01-02T00:00:00Z' });
    });
  });

  it('keeps lastChangelogRelease separate between two repos', async () => {
    await withRepo('owner/repo-a', () => setLastChangelogRelease('v1', '2026-01-01T00:00:00Z'));

    const a = await withRepo('owner/repo-a', getLastChangelogRelease);
    const b = await withRepo('owner/repo-b', getLastChangelogRelease);

    expect(a).toEqual({ tag: 'v1', publishedAt: '2026-01-01T00:00:00Z' });
    expect(b).toBeUndefined();
  });
});

describe('processed comments', () => {
  it('records a comment as done, per repo, and prunes entries past the age limit', async () => {
    await withRepo('acme/product', async () => {
      await recordProcessedComment('issue-1', 1000);
      expect(await getProcessedComments()).toEqual(new Set(['issue-1']));
      const state = await readLocalState();
      state.processedComments['issue-old'] = new Date(Date.now() - 5000).toISOString();
      const { writeLocalState } = await import('./local-state.js');
      await writeLocalState(state);
      await recordProcessedComment('review-2', 1000);
      expect(await getProcessedComments()).toEqual(new Set(['issue-1', 'review-2']));
    });
    await withRepo('acme/other', async () => {
      expect((await getProcessedComments()).size).toBe(0);
    });
  });
});

describe('blocks', () => {
  const block = (reason: string, at: string) => ({ reason, url: 'https://github.com/acme/product/issues/1', at });

  it('keeps the latest reason per item, per repo', async () => {
    await withRepo('acme/product', async () => {
      await recordBlock(1, block('e2e falla', '2026-10-16T01:00:00Z'), 1000 * 60);
      await recordBlock(1, block('falta un secreto', '2026-10-16T01:00:10Z'), 1000 * 60);
      await recordBlock(2, block('spec ambiguo', '2026-10-16T01:00:20Z'), 1000 * 60);
      expect(await getBlocks()).toEqual({ 1: block('falta un secreto', '2026-10-16T01:00:10Z'), 2: block('spec ambiguo', '2026-10-16T01:00:20Z') });
    });
    await withRepo('acme/other', async () => {
      expect(await getBlocks()).toEqual({});
    });
  });

  it('prunes reasons past the age limit', async () => {
    await withRepo('acme/product', async () => {
      await recordBlock(1, block('viejo', '2026-01-01T00:00:00Z'), 1000);
      await recordBlock(2, block('nuevo', '2026-10-16T00:00:00Z'), 1000);
      expect(Object.keys(await getBlocks())).toEqual(['2']);
    });
  });
});

