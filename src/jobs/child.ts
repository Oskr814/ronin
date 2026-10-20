import { getDb } from '../db/db.js';
import { log } from '../core/logger.js';
import { finish, heartbeat, HEARTBEAT_MS } from './store.js';

// In a job's own process — a tick (index.ts) or an event's handler — when
// the runner started it (RONIN_JOB_ID): renews the job's lease while `fn`
// runs and marks how it ended, so the job outlives a restart of the server
// that started it. Started any other way (by hand, by the old cron), it just
// runs `fn`.
export async function runAsJob(fn: () => Promise<void>): Promise<void> {
  const id = process.env.RONIN_JOB_ID;
  // Not for whatever this process launches in turn (a worker).
  delete process.env.RONIN_JOB_ID;
  const db = getDb();
  if (!id || !db) return fn();

  await heartbeat(db, id, process.pid);
  const timer = setInterval(() => {
    heartbeat(db, id, process.pid).catch((error) => log.error(`trabajo ${id}: no se pudo renovar el lease`, error));
  }, HEARTBEAT_MS);
  timer.unref();
  // Cut short (the handler's own time cap, a kill): said so before going.
  const onSignal = (signal: NodeJS.Signals) => {
    finish(db, id, { error: `cortado (${signal})` }).catch(() => {}).finally(() => process.exit(1));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await fn();
    await finish(db, id);
  } catch (error) {
    await finish(db, id, { error: (error as Error).message ?? String(error) }).catch(() => {});
    throw error;
  } finally {
    clearInterval(timer);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}
