import { hostname } from 'node:os';
import type { Db } from '@platform/db/db.js';
import { log } from '@platform/logger.js';
import { launchScript } from '@platform/workers/worker-launch.js';
import { claimNext, finish, reapExpired, type Job, type JobKind } from './store.js';

// The local runner (#235, stage 3): a loop inside the server that takes the
// queue's jobs and starts each in its own process — as the cron and the
// webhook server did — so one that hangs doesn't hold the rest. The process
// renews the job's lease itself (child.ts): restarting the server leaves it
// running.

// How many of each run at once: one tick (a second one waits its turn, as
// .tick.pending made it), and the events' handlers, which mostly wait on
// their issue's lock. A worker the API asked for (#325) is only handed over:
// its job ends as soon as it starts.
export const CAPS: Record<JobKind, number> = { tick: 1, event: 20, worker: 20 };

export interface WorkerJob {
  name: string;
  request: unknown;
}

const SCRIPTS: Record<JobKind, (job: Job) => [string, string[]]> = {
  tick: () => ['apps/api/tick/main', []],
  event: (job) => ['apps/api/webhooks/handler', [JSON.stringify(job.payload)]],
  worker: (job) => [(job.payload as WorkerJob).name, [JSON.stringify((job.payload as WorkerJob).request)]],
};

const POLL_MS = 2000;
const REAP_EVERY = 15;

export function runnerName(): string {
  return `${hostname()}:${process.pid}`;
}

// One pass: the lost ones marked, and every job there's room for started.
export async function runOnce(db: Db, launch = launchScript): Promise<Job[]> {
  const started: Job[] = [];
  for (const kind of Object.keys(CAPS) as JobKind[]) {
    for (let job = await claimNext(db, kind, CAPS[kind], runnerName()); job; job = await claimNext(db, kind, CAPS[kind], runnerName())) {
      const [script, args] = SCRIPTS[kind](job);
      try {
        const pid = launch(script, args, { RONIN_JOB_ID: job.id });
        if (!pid) throw new Error('el proceso no arrancó');
        log.info(`cola: ${kind} ${job.id}${job.repo ? ` (${job.repo})` : ''} arrancó, pid ${pid}`);
        // A worker doesn't renew a lease (runAsJob): it runs on its own, as when the API started it.
        if (kind === 'worker') await finish(db, job.id);
        started.push(job);
      } catch (error) {
        log.error(`cola: no se pudo arrancar ${kind} ${job.id}`, error);
        await finish(db, job.id, { error: (error as Error).message });
      }
    }
  }
  return started;
}

// Returns how to stop it: no job is taken after it resolves.
export function startRunner(db: Db): () => Promise<void> {
  let passes = 0;
  let busy = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      if (passes++ % REAP_EVERY === 0) {
        const lost = await reapExpired(db);
        if (lost) log.error(`cola: ${lost} trabajo(s) perdido(s): su proceso dejó de renovar el lease`);
      }
      await runOnce(db);
    } catch (error) {
      log.error('cola: falló una vuelta del runner', error);
    } finally {
      busy = false;
    }
  }, POLL_MS);
  timer.unref();
  log.info(`cola: runner local ${runnerName()} tomando trabajos (tick: ${CAPS.tick}, eventos: ${CAPS.event})`);
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
  };
}
