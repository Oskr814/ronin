import { log } from '../logger.js';

// Minimal bounded worker pool — no new dependency for something this small.
// `limit` lanes each pull the next item off a shared index until the list is
// exhausted, so at most `limit` invocations of `worker` are ever in flight at
// once. One lane's rejection doesn't stop the others: each item is handled
// independently by its caller (see tick.ts's runIssueStep), so a single
// issue failing must never starve the rest of their turn.
export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function lane(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// A unit of a tick's work, of any flow (an issue's pipeline, an external
// review, a /spike…). `run` is expected to handle its own errors, like every
// process*Candidate in tick.ts; a rejection that still escapes is logged and
// never stops the rest.
export interface Job {
  kind: string;
  label: string;
  run: () => Promise<void>;
}

// runWithConcurrency for jobs of mixed kinds: at most `limit` at once
// overall, and at most caps[kind] of one kind (a kind without a cap is only
// bound by `limit`). Jobs start in list order, skipping over one whose kind is
// at its cap — so a cap of 1 also keeps that kind strictly sequential.
export async function runJobs(jobs: Job[], limit: number, caps: Record<string, number> = {}): Promise<void> {
  const pending = [...jobs];
  const running = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  const canStart = (job: Job) => (running.get(job.kind) ?? 0) < (caps[job.kind] ?? Infinity);

  while (pending.length > 0 || inFlight.size > 0) {
    while (inFlight.size < limit) {
      const index = pending.findIndex(canStart);
      if (index < 0) break;
      const [job] = pending.splice(index, 1);
      running.set(job.kind, (running.get(job.kind) ?? 0) + 1);
      const done: Promise<void> = job
        .run()
        .catch((error) => log.error(`${job.kind} ${job.label}: error no manejado`, error))
        .finally(() => {
          running.set(job.kind, running.get(job.kind)! - 1);
          inFlight.delete(done);
        });
      inFlight.add(done);
    }
    // Only possible with a cap of 0: nothing left can ever start.
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
}
