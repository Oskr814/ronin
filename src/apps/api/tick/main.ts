// Entrypoint for a single supervisor tick. Queued by the server's scheduler
// with DATABASE_URL (apps/api/jobs/scheduler.ts, #235 stage 3), else invoked by cron
// (see scripts/setup-cron.sh) — each tick is its own process, so no state leaks
// between runs beyond what's in GitHub (and the local claim cache, see
// claim.ts).
import { tick } from './tick.js';
import { log } from '../../../platform/logger.js';
import { runAsJob } from '../jobs/child.js';
import { runWorker } from '../../../platform/workers/run.js';

// Started by the job queue's runner (apps/api/jobs/runner.ts), it renews its job's
// lease and marks how it ended; by cron, it just runs.
runWorker('tick', async () => {
  await runAsJob(tick);
  log.info('tick complete');
});
