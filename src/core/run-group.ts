import { AsyncLocalStorage } from 'node:async_hooks';

// Agent runs that are steps of one thing, recorded as such: a preview's
// seed catalog, "¿alcanzan los seeds?" and its data are one preview, and the
// dashboard shows them as one run with its steps (run-record.ts's `group`).
// Whatever runs inside withRunGroup, however deep, carries it.
const store = new AsyncLocalStorage<string>();

export function withRunGroup<T>(group: string, fn: () => Promise<T>): Promise<T> {
  return store.run(group, fn);
}

export const currentRunGroup = (): string | undefined => store.getStore();

// A preview's group: its PR and when it came up or moved (preview.ts).
export const previewRunGroup = (prNumber: number, now = new Date()): string => `preview:${prNumber}:${now.toISOString()}`;
