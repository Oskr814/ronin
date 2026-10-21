import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDb, type Db } from '../db/db.js';
import { TEST_DATABASE_URL, testDb } from '../db/testing.js';
import { fromEntries, toEntries } from './local-state-db.js';
import type { LocalState } from './local-state.js';

// local-state.test.ts again, with the state in Postgres (#235, stage 3.3):
// the same behavior, whichever keeps it.
if (TEST_DATABASE_URL) {
  process.env.RONIN_TEST_STORE = 'pg';
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('repo_state').execute();
  });
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  await import('./local-state.test.js');

  describe('repo_state', () => {
    it('writes only the entries that changed, and deletes the ones gone', async () => {
      const { readLocalState, writeLocalState } = await import('./local-state.js');
      const { withActiveRepo } = await import('../agents/repo-context.js');
      await withActiveRepo({ productRepo: 'acme/product', productRepoPath: '/tmp/unused' }, async () => {
        const state = await readLocalState();
        state.claimedIssues = [3, 1];
        state.checksPendingCounts = { 7: 2 };
        await writeLocalState(state);
        const before = await db.selectFrom('repo_state').select(['kind', 'key', 'updated_at']).execute();
        expect(before).toHaveLength(3);

        await new Promise((r) => setTimeout(r, 20));
        state.claimedIssues = [3];
        await writeLocalState(state);
        const after = await db.selectFrom('repo_state').select(['kind', 'key', 'updated_at']).orderBy('key').execute();
        expect(after.map((r) => r.key)).toEqual(['3', '7']);
        const same = (key: string) => before.find((r) => r.key === key)!.updated_at.getTime() === after.find((r) => r.key === key)!.updated_at.getTime();
        expect(same('3') && same('7')).toBe(true);
        expect((await readLocalState()).claimedIssues).toEqual([3]);
      });
    });
  });
} else {
  it.skip('needs TEST_DATABASE_URL', () => {});
}

describe('toEntries / fromEntries', () => {
  it('round-trips every field, and tells "never seeded" from empty', () => {
    const state: LocalState = {
      claimedIssues: [4, 12],
      checksPendingCounts: { 30: 2 },
      lastReviewedSha: { 31: 'abc' },
      failureSignatures: { 30: { h1: 2 } },
      lastChangelogRelease: { tag: 'v1', publishedAt: '2026-01-01T00:00:00Z' },
      nightlyExploration: { web: '2026-10-20' },
      processedComments: { 'issue-1': '2026-10-20T00:00:00Z' },
      blocks: { 4: { reason: 'r', url: 'u', at: '2026-10-20T00:00:00Z' } },
      linearPending: [{ number: 12, projectName: 'P', since: '2026-10-20T00:00:00Z' }],
      autoMergeDefaulted: [],
    };
    expect(fromEntries(toEntries(state))).toEqual(state);
    const { autoMergeDefaulted: _, lastChangelogRelease: __, ...unseeded } = state;
    expect(fromEntries(toEntries(unseeded))).toEqual(unseeded);
  });
});
