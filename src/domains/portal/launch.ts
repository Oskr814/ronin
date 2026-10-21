import { launchWorker } from '../../core/worker-launch.js';
import { log } from '../../core/logger.js';
import { needsIssue } from './issue.js';
import { addEvent, listRequests, updateRequest } from './requests.js';

// Starts the worker that reads a request and draws its prototype
// (worker.ts), and notes its pid on
// the request so the tick can tell when it died. `by`: who launched it, for
// the request's activity (#132).
export async function launchPortalWorker(n: number, by: 'server' | 'tick' = 'server'): Promise<void> {
  const pid = launchWorker('domains/portal/worker', { number: n });
  if (pid) await updateRequest(n, (r) => {
    r.worker = { pid, since: new Date().toISOString() };
    addEvent(r, { kind: 'worker', by, pid });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// A grace period for a worker that was just launched and hasn't written its
// pid yet.
const GRACE_MS = 2 * 60_000;

// The tick's reconciliation: a request still 'thinking', 'minor' (its
// prototype on the way), 'reproducing' (#137), or approved or the team's without its issue yet,
// whose worker is gone (the server restarted
// mid-launch, the runner rebooted) gets a new one.
export async function sweepPortalRequests(now = Date.now(), launch: (n: number, by: 'tick') => Promise<void> = launchPortalWorker): Promise<void> {
  for (const request of await listRequests()) {
    if (!(request.status === 'thinking' || request.status === 'minor' || request.status === 'reproducing' || needsIssue(request))) continue;
    if (request.worker && (alive(request.worker.pid) || now - Date.parse(request.worker.since) < GRACE_MS)) continue;
    if (!request.worker && now - Date.parse(request.updatedAt) < GRACE_MS) continue;
    log.info(`portal: el pedido P-${request.number} quedó sin quien lo lea; lanzo otro worker`);
    await launch(request.number, 'tick').catch((error) => log.error(`portal: no se pudo relanzar el pedido P-${request.number}`, error));
  }
}
