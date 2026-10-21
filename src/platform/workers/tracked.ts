import { log } from '../logger.js';
import { launchWorker } from './worker-launch.js';
import { pidAlive } from './process.js';

// A worker per document (a meeting, a portal request) that notes its pid on
// it, so the tick can tell when it died and launch another.

export interface TrackedDoc {
  number: number;
  updatedAt: string;
  worker?: { pid: number; since: string };
}

export type LaunchedBy = 'server' | 'tick';

// A grace period for a worker that was just launched and hasn't written its
// pid yet.
const GRACE_MS = 2 * 60_000;

export function trackedWorker<T extends TrackedDoc>(spec: {
  // The worker, as launchWorker takes it: 'domains/meetings/worker'.
  name: string;
  // For the log: 'reuniones', and the document ('R-3', 'el pedido P-3').
  area: string;
  subject: (n: number) => string;
  list: () => Promise<T[]>;
  // Still needs a worker: what the worker hasn't done yet.
  pending: (doc: T) => boolean;
  // Notes the launched worker on the document, with `by` for its activity.
  noteLaunch: (n: number, pid: number, by: LaunchedBy) => Promise<unknown>;
}) {
  async function launch(n: number, by: LaunchedBy = 'server'): Promise<void> {
    const pid = launchWorker(spec.name, { number: n });
    if (pid) await spec.noteLaunch(n, pid, by);
  }

  // The tick's reconciliation: a document still pending whose worker is gone
  // (the server restarted mid-launch, the runner rebooted) gets a new one.
  async function sweep(now = Date.now(), relaunch: (n: number, by: 'tick') => Promise<void> = launch): Promise<void> {
    for (const doc of await spec.list()) {
      if (!spec.pending(doc)) continue;
      if (doc.worker && (pidAlive(doc.worker.pid) || now - Date.parse(doc.worker.since) < GRACE_MS)) continue;
      if (!doc.worker && now - Date.parse(doc.updatedAt) < GRACE_MS) continue;
      log.info(`${spec.area}: ${spec.subject(doc.number)} quedó sin worker; lanzo otro`);
      await relaunch(doc.number, 'tick').catch((error) => log.error(`${spec.area}: no se pudo relanzar ${spec.subject(doc.number)}`, error));
    }
  }

  return { launch, sweep };
}
