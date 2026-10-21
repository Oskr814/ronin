import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../../platform/db/db.js';
import { config } from '../../../platform/config/config.js';
import { log } from '../../../platform/logger.js';
import { logsDir } from '../../../platform/agents/run-files.js';
import { enqueue, lastQueuedOrStarted, pruneFinished } from './store.js';

// The scheduler (#235, stage 3): what cron did, inside the server. The tick
// — the reconciliation pass over every repo — is queued at the same times
// (every TICK_INTERVAL_MINUTES from the hour: :00 and :30 by default); one
// already queued isn't queued again, so a tick still running when the next
// time comes is followed by exactly one more, as .tick.pending did. And
// once in a while, what the cron wrapper pruned: logs and run records older
// than 14 days, and the queue's finished jobs.

const CHECK_MS = 20_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
export const RETENTION_DAYS = 14;

// The last time a tick was due, at or before `now`: the interval's last
// boundary, counted from the hour (from the day for intervals over 60).
export function lastBoundary(now: Date, intervalMinutes: number): Date {
  const base = new Date(now);
  base.setSeconds(0, 0);
  const span = intervalMinutes > 60 ? 24 * 60 : 60;
  const since = intervalMinutes > 60 ? base.getHours() * 60 + base.getMinutes() : base.getMinutes();
  const into = (since % span) % intervalMinutes;
  return new Date(base.getTime() - into * 60_000);
}

// Whether a tick is due: none queued or started since the last boundary.
export function tickDue(now: Date, intervalMinutes: number, last: Date | null): boolean {
  return !last || last.getTime() < lastBoundary(now, intervalMinutes).getTime();
}

export async function scheduleTick(db: Db, now = new Date()): Promise<boolean> {
  if (!tickDue(now, config.tickIntervalMinutes, await lastQueuedOrStarted(db, 'tick'))) return false;
  const id = await enqueue(db, 'tick', { dedupeKey: 'tick' });
  if (id) log.info(`planificador: tick en cola (${id})`);
  return true;
}

// tick-<day>.log files and runs/<day>/ folders older than RETENTION_DAYS.
export async function pruneLogs(dir = logsDir(), now = Date.now()): Promise<number> {
  const old = (mtimeMs: number) => now - mtimeMs > RETENTION_DAYS * 24 * 60 * 60_000;
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^tick-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    if (old((await stat(join(dir, name))).mtimeMs)) {
      await rm(join(dir, name), { force: true });
      removed++;
    }
  }
  for (const name of await readdir(join(dir, 'runs')).catch(() => [] as string[])) {
    const path = join(dir, 'runs', name);
    if (old((await stat(path)).mtimeMs)) {
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

export function startScheduler(db: Db): () => void {
  let lastPrune = 0;
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      await scheduleTick(db);
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        const [files, jobs] = await Promise.all([pruneLogs(), pruneFinished(db, RETENTION_DAYS)]);
        if (files || jobs) log.info(`planificador: limpieza, ${files} archivo(s) de log y ${jobs} trabajo(s) viejos`);
      }
    } catch (error) {
      log.error('planificador: falló una vuelta', error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(pass, CHECK_MS);
  timer.unref();
  void pass();
  log.info(`planificador: un tick cada ${config.tickIntervalMinutes} min`);
  return () => clearInterval(timer);
}
