import { hostname } from 'node:os';
import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import { pidAlive } from '../workers/process.js';

// The locks and slots of locks.ts in Postgres (#235, stage 3.2), with
// DATABASE_URL: one row per lock (scope = the repo, name = issue-12, all-0…)
// held by this process (host:pid) with a lease it renews every 30 s. One
// whose lease ran out is taken over; one held by a process of this host that
// is gone, right away — as the pid files did, without waiting for the lease.

export const LOCK_LEASE_MS = 90_000;
const RENEW_MS = 30_000;

const HOST = hostname();
export const holderId = (): string => `${HOST}:${process.pid}`;
const leaseUntil = () => sql<string>`now() + ${`${LOCK_LEASE_MS} milliseconds`}::interval`;

// Renews every lease this process holds while it holds any.
let renewing: NodeJS.Timeout | undefined;
let heldCount = 0;
function renewWhileHeld(db: Db, delta: number): void {
  heldCount = Math.max(0, heldCount + delta);
  if (heldCount > 0 && !renewing) {
    renewing = setInterval(() => {
      void db.updateTable('locks').set({ lease_until: leaseUntil() }).where('holder', '=', holderId()).execute().catch(() => {});
      void db.updateTable('lock_waits').set({ lease_until: leaseUntil() }).where('holder', '=', holderId()).execute().catch(() => {});
    }, RENEW_MS);
    renewing.unref();
  } else if (heldCount === 0 && renewing) {
    clearInterval(renewing);
    renewing = undefined;
  }
}

async function insert(db: Db, scope: string, name: string): Promise<boolean> {
  const row = await db.insertInto('locks')
    .values({ scope, name, holder: holderId(), host: HOST, pid: process.pid, lease_until: leaseUntil() })
    .onConflict((oc) => oc.columns(['scope', 'name']).doUpdateSet({ holder: holderId(), host: HOST, pid: process.pid, acquired_at: sql<string>`now()`, lease_until: leaseUntil() })
      .where('locks.lease_until', '<', sql<Date>`now()`))
    .returning('holder')
    .executeTakeFirst();
  return row?.holder === holderId();
}

// Never waits: false means someone else holds it.
export async function tryTake(db: Db, scope: string, name: string): Promise<boolean> {
  let taken = await insert(db, scope, name);
  if (!taken) {
    const current = await db.selectFrom('locks').select(['host', 'pid', 'holder']).where('scope', '=', scope).where('name', '=', name).executeTakeFirst();
    if (current && current.host === HOST && current.pid !== process.pid && !pidAlive(current.pid)) {
      await db.deleteFrom('locks').where('scope', '=', scope).where('name', '=', name).where('holder', '=', current.holder).execute();
      taken = await insert(db, scope, name);
    }
  }
  if (taken) renewWhileHeld(db, 1);
  return taken;
}

export async function release(db: Db, scope: string, name: string): Promise<void> {
  const gone = await db.deleteFrom('locks').where('scope', '=', scope).where('name', '=', name).where('holder', '=', holderId()).returning('name').execute();
  if (gone.length) renewWhileHeld(db, -1);
}

// What's waiting for a slot: a row from its first failed try until it has
// them. Returns its id, to clear it.
export async function markWaiting(db: Db, wait: { kind: string; label: string; repo?: string }): Promise<string> {
  const row = await db.insertInto('lock_waits')
    .values({ holder: holderId(), kind: wait.kind, label: wait.label, repo: wait.repo ?? null, since: new Date().toISOString(), lease_until: leaseUntil() })
    .returning('id').executeTakeFirstOrThrow();
  renewWhileHeld(db, 1);
  return String(row.id);
}

export async function clearWaiting(db: Db, id: string): Promise<void> {
  const gone = await db.deleteFrom('lock_waits').where('id', '=', id).returning('id').execute();
  if (gone.length) renewWhileHeld(db, -1);
}

// For the dashboard: the slots in use per repo, and what's waiting — only
// what a live holder has (a lease not run out).
export async function slotsInUseDb(db: Db): Promise<Record<string, number>> {
  const rows = await db.selectFrom('locks').select(['scope', (eb) => eb.fn.countAll<string>().as('n')])
    .where('name', 'like', 'all-%').where('lease_until', '>', sql<Date>`now()`).groupBy('scope').execute();
  return Object.fromEntries(rows.map((r) => [r.scope, Number(r.n)]));
}

export async function waitingDb(db: Db): Promise<Array<{ kind: string; label: string; repo?: string; since: string }>> {
  const rows = await db.selectFrom('lock_waits').select(['kind', 'label', 'repo', 'since']).where('lease_until', '>', sql<Date>`now()`).orderBy('since').execute();
  return rows.map((r) => ({ kind: r.kind, label: r.label, ...(r.repo ? { repo: r.repo } : {}), since: r.since.toISOString() }));
}
