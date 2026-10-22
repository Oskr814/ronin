// The runner as a process of its own (#325): the scheduler and the job
// queue's runner, without listeners. The API (apps/api/main.ts, started as
// `api`) only queues, so either one is redeployed without the other.
//
// Stopping it (SIGTERM, what `docker compose up -d` sends) is a drain: no new
// job is taken, and it goes once every process it started has ended — the
// queue keeps what arrives meanwhile for the runner that comes next.
import { getDb } from '@platform/db/db.js';
import { migrateToLatest } from '@platform/db/migrate.js';
import { log } from '@platform/logger.js';
import { drain } from './drain.js';
import { startRunner } from './runner.js';
import { startScheduler } from './scheduler.js';

const db = getDb();
if (!db) throw new Error('DATABASE_URL no está seteado: el runner toma los trabajos de la cola en Postgres.');

// The same migrations the API runs: whichever starts first applies them, under
// Kysely's lock.
try {
  const ran = await migrateToLatest(db);
  log.info(ran.length ? `base de datos: migraciones aplicadas: ${ran.join(', ')}` : 'base de datos: al día');
} catch (error) {
  log.error('base de datos: no se pudo migrar', error);
}

const stopScheduler = startScheduler(db);
const stopRunner = startRunner(db);
// Keeps the process up: the timers above don't.
const alive = setInterval(() => {}, 1 << 30);

let stopping = false;
async function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  log.info(`runner: ${signal}, no toma más trabajos y espera a los que están corriendo`);
  stopScheduler();
  await stopRunner();
  await drain((busy) => log.info(`runner: esperando a ${busy} proceso(s) antes de salir`));
  log.info('runner: no queda nada corriendo, sale');
  clearInterval(alive);
  process.exit(0);
}
process.on('SIGTERM', (signal) => void stop(signal));
process.on('SIGINT', (signal) => void stop(signal));
