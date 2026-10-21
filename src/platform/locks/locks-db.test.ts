import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { setDb, type Db } from '../db/db.js';
import { TEST_DATABASE_URL, testDb } from '../db/testing.js';

let repo = 'acme/app';
vi.mock('../agents/repo-context.js', () => ({ activeRepo: () => ({ worktreeBasePath: '/nunca-se-usa', productRepo: repo }) }));

const { holderId, release, slotsInUseDb, tryTake, waitingDb } = await import('./locks-db.js');
const { tryLockResource, unlockResource, withResourceLock, withSlots } = await import('./locks.js');

describe.skipIf(!TEST_DATABASE_URL)('locks and slots in Postgres', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    repo = 'acme/app';
    await db.deleteFrom('locks').execute();
    await db.deleteFrom('lock_waits').execute();
  });

  it('holds a resource for one at a time, per repo, until it is released', async () => {
    expect(await tryLockResource('issue-12')).toBe(true);
    // The same process's other job doesn't get it either.
    expect(await tryLockResource('issue-12')).toBe(false);
    repo = 'acme/otra';
    expect(await tryLockResource('issue-12')).toBe(true);
    await unlockResource('issue-12');
    repo = 'acme/app';
    await unlockResource('issue-12');
    expect(await db.selectFrom('locks').selectAll().execute()).toEqual([]);
  });

  it('never gives one held by another live process, and takes over one whose lease ran out', async () => {
    await db.insertInto('locks').values({ scope: 'acme/app', name: 'issue-7', holder: 'otra-maquina:1', host: 'otra-maquina', pid: 1, lease_until: sql<string>`now() + interval '1 minute'` }).execute();
    expect(await tryTake(db, 'acme/app', 'issue-7')).toBe(false);
    await db.updateTable('locks').set({ lease_until: sql<string>`now() - interval '1 second'` }).execute();
    expect(await tryTake(db, 'acme/app', 'issue-7')).toBe(true);
    expect((await db.selectFrom('locks').select('holder').executeTakeFirstOrThrow()).holder).toBe(holderId());
    await release(db, 'acme/app', 'issue-7');
  });

  it('takes over at once one held by a process of this host that is gone', async () => {
    const { hostname } = await import('node:os');
    await db.insertInto('locks').values({ scope: 'acme/app', name: 'pr-9', holder: `${hostname()}:999999999`, host: hostname(), pid: 999_999_999, lease_until: sql<string>`now() + interval '1 minute'` }).execute();
    expect(await tryTake(db, 'acme/app', 'pr-9')).toBe(true);
    await release(db, 'acme/app', 'pr-9');
  });

  it('skips a taken resource, and runs once it is free', async () => {
    expect(await tryLockResource('issue-3')).toBe(true);
    const ran = vi.fn(async () => {});
    expect(await withResourceLock('issue-3', 'skip', ran)).toBe(false);
    await unlockResource('issue-3');
    expect(await withResourceLock('issue-3', 'skip', ran)).toBe(true);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('lets only `limit` jobs of a repo run at once, shows what waits, and counts the slots in use', async () => {
    let running = 0;
    let most = 0;
    let seenWaiting = 0;
    let seenSlots = 0;
    const job = (n: number) => withSlots('issue', 2, {}, async () => {
      running++;
      most = Math.max(most, running);
      seenSlots = Math.max(seenSlots, (await slotsInUseDb(db))['acme/app'] ?? 0);
      await new Promise((r) => setTimeout(r, 150));
      // After the work, not at its start: by then the ones left out have
      // surely said they wait.
      seenWaiting = Math.max(seenWaiting, (await waitingDb(db)).length);
      running--;
      return n;
    }, `issue #${n}`);
    expect(await Promise.all([1, 2, 3, 4].map(job))).toEqual([1, 2, 3, 4]);
    expect(most).toBe(2);
    expect(seenSlots).toBe(2);
    expect(seenWaiting).toBeGreaterThan(0);
    expect(await waitingDb(db)).toEqual([]);
    expect(await db.selectFrom('locks').selectAll().execute()).toEqual([]);
  });
});
