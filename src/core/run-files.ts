import { join } from 'node:path';

// Where ronin writes what the dashboard (#65) reads: the
// per-run records (logs/runs/) and each Claude account's usage
// (logs/usage/). Next to the daily tick log, which the cron wrapper writes to
// the same logs/ (scripts/run-tick.sh). RONIN_LOGS_DIR moves it; the tests
// point it at a scratch dir (test/setup-env.ts).
export function logsDir(): string {
  return process.env.RONIN_LOGS_DIR ?? join(process.cwd(), 'logs');
}

// Local date, like the tick log's name (`date +%F` in run-tick.sh).
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
