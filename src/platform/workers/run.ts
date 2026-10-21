import { log } from '../logger.js';
import { loadRepos } from '../config/repos.js';
import { withActiveRepo, type RepoEntry } from '../agents/repo-context.js';

// What every worker's entry point shares (launchWorker starts them): the
// request is its one JSON argument, and a failure is logged and ends the
// process with code 1.

export function workerRequest<R>(): R {
  return JSON.parse(process.argv[2] ?? '{}') as R;
}

// Runs the worker's main. `failed`: the log line's subject ('preview-worker',
// `meeting-worker R-${n}`); `onFailure`: what else the worker does then, like
// noting it on the meeting. Its own failure is left out of the way.
export function runWorker(failed: string, main: () => Promise<void>, onFailure?: (error: unknown) => Promise<unknown>): void {
  main().catch(async (error) => {
    log.error(`${failed} falló`, error);
    if (onFailure) await onFailure(error).catch(() => {});
    process.exitCode = 1;
  });
}

// Runs fn with a product repo of repos.json as the active repo.
export async function withProductRepo<T>(repo: string, fn: (entry: RepoEntry) => Promise<T>): Promise<T> {
  const entry = (await loadRepos()).find((r) => r.productRepo === repo);
  if (!entry) throw new Error(`${repo} no está en repos.json`);
  return withActiveRepo(entry, () => fn(entry));
}
