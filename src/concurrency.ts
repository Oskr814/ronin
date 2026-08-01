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
