// Entrypoint for a single supervisor tick. Queued by the server's scheduler
// with DATABASE_URL (jobs/scheduler.ts, #235 stage 3), else invoked by cron
// (see scripts/setup-cron.sh) — each tick is its own process, so no state leaks
// between runs beyond what's in GitHub (and the local claim cache, see
// claim.ts).
import { tick } from './tick.js';
import { log } from './core/logger.js';
import { runAsJob } from './jobs/child.js';

// Started by the job queue's runner (jobs/runner.ts), it renews its job's
// lease and marks how it ended; by cron, it just runs.
runAsJob(tick)
  .then(() => {
    log.info('tick complete');
  })
  .catch((error) => {
    log.error('tick failed', error);
    process.exitCode = 1;
  });
