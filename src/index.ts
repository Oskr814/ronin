// Entrypoint for a single supervisor tick. Invoked repeatedly by cron (see
// scripts/setup-cron.sh) — each tick is its own process, so no state leaks
// between runs beyond what's in GitHub (and the local claim cache, see
// claim.ts).
import { tick } from './tick.js';
import { log } from './core/logger.js';

tick()
  .then(() => {
    log.info('tick complete');
  })
  .catch((error) => {
    log.error('tick failed', error);
    process.exitCode = 1;
  });
