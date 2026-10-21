import { sql } from 'kysely';
import type { Db } from '../../../platform/db/db.js';

// The job queue (#235, stage 3): what used to be the cron tick and a
// process per webhook event, as rows in Postgres that the runner
// (runner.ts) takes. Nothing here runs a job: it only keeps their state.
//
// A job's own process renews its lease while it runs and marks how it
// ended (child.ts), so a restart of the server — every deploy — neither
// cuts it nor runs it twice. One whose lease runs out (its process died) is
// marked lost; nothing is retried yet: the next tick reconciles, as before.

export type JobKind = 'tick' | 'event';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'lost';

export interface Job {
  id: string;
  kind: JobKind;
  repo: string | null;
  payload: unknown;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  error?: string;
}

// How long a lease lasts without being renewed, and how often its process
// renews it.
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;

const iso = (d: Date | null) => d?.toISOString();
const toJob = (r: { id: string; kind: string; repo: string | null; payload: unknown; status: string; created_at: Date; started_at: Date | null; finished_at: Date | null; pid: number | null; error: string | null }): Job => ({
  id: String(r.id),
  kind: r.kind as JobKind,
  repo: r.repo,
  payload: r.payload,
  status: r.status as JobStatus,
  createdAt: r.created_at.toISOString(),
  ...(r.started_at ? { startedAt: iso(r.started_at) } : {}),
  ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
  ...(r.pid !== null ? { pid: r.pid } : {}),
  ...(r.error ? { error: r.error } : {}),
});

// Queues one. With a dedupe key, a job already queued with that key is
// left as it is and nothing new is queued: returns null then.
export async function enqueue(db: Db, kind: JobKind, opts: { repo?: string; payload?: unknown; dedupeKey?: string } = {}): Promise<string | null> {
  const row = await db.insertInto('jobs')
    .values({ kind, repo: opts.repo ?? null, payload: JSON.stringify(opts.payload ?? {}), dedupe_key: opts.dedupeKey ?? null, status: 'queued' })
    .onConflict((oc) => oc.column('dedupe_key').where('status', '=', 'queued').doNothing())
    .returning('id')
    .executeTakeFirst();
  return row ? String(row.id) : null;
}

// Takes the oldest queued job of `kind` that's due, if fewer than `cap` of
// that kind are running: it's running from now on, leased to `runner`. Two
// runners never take the same one (FOR UPDATE SKIP LOCKED), and the count
// is taken under a lock per kind, so the cap holds across them.
export async function claimNext(db: Db, kind: JobKind, cap: number, runner: string): Promise<Job | null> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`jobs:${kind}`}))`.execute(trx);
    const { running } = await trx.selectFrom('jobs').select((eb) => eb.fn.countAll<string>().as('running')).where('kind', '=', kind).where('status', '=', 'running').executeTakeFirstOrThrow();
    if (Number(running) >= cap) return null;
    const next = await trx.selectFrom('jobs').select('id').where('kind', '=', kind).where('status', '=', 'queued').where('run_after', '<=', sql<Date>`now()`)
      .orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst();
    if (!next) return null;
    const row = await trx.updateTable('jobs')
      .set({ status: 'running', started_at: sql`now()` as unknown as string, lease_until: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` as unknown as string, runner })
      .where('id', '=', next.id).returningAll().executeTakeFirstOrThrow();
    return toJob(row);
  });
}

// From the job's own process: who's running it, and its lease renewed.
export async function heartbeat(db: Db, id: string, pid: number): Promise<void> {
  await db.updateTable('jobs').set({ pid, lease_until: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` as unknown as string })
    .where('id', '=', id).where('status', '=', 'running').execute();
}

export async function finish(db: Db, id: string, outcome: { error?: string } = {}): Promise<void> {
  await db.updateTable('jobs').set({ status: outcome.error ? 'failed' : 'done', finished_at: sql`now()` as unknown as string, lease_until: null, error: outcome.error?.slice(0, 2000) ?? null })
    .where('id', '=', id).where('status', '=', 'running').execute();
}

// The running ones whose lease ran out: their process is gone. Returns how many.
export async function reapExpired(db: Db): Promise<number> {
  const rows = await db.updateTable('jobs').set({ status: 'lost', finished_at: sql`now()` as unknown as string, error: 'su proceso dejó de renovar el lease' })
    .where('status', '=', 'running').where('lease_until', '<', sql<Date>`now()`).returning('id').execute();
  return rows.length;
}

// When the last one of `kind` started (or was queued, if none started yet).
export async function lastQueuedOrStarted(db: Db, kind: JobKind): Promise<Date | null> {
  const row = await db.selectFrom('jobs').select((eb) => eb.fn.max(sql<Date>`coalesce(started_at, created_at)`).as('at')).where('kind', '=', kind).executeTakeFirst();
  return row?.at ? new Date(row.at) : null;
}

export async function listJobs(db: Db, opts: { status?: JobStatus[]; limit?: number } = {}): Promise<Job[]> {
  let q = db.selectFrom('jobs').selectAll().orderBy('id', 'desc').limit(opts.limit ?? 100);
  if (opts.status?.length) q = q.where('status', 'in', opts.status);
  return (await q.execute()).map(toJob);
}

// Old finished ones go, as the logs do (14 days).
export async function pruneFinished(db: Db, olderThanDays = 14): Promise<number> {
  const rows = await db.deleteFrom('jobs').where('status', 'in', ['done', 'failed', 'lost']).where('finished_at', '<', sql<Date>`now() - ${`${olderThanDays} days`}::interval`).returning('id').execute();
  return rows.length;
}
