import { trackedWorker } from '@platform/workers/tracked.js';
import { needsIssue } from './issue.js';
import { addEvent, listRequests, updateRequest } from './requests.js';

// The worker that reads a request and draws its prototype (worker.ts), its
// pid noted on the request so the tick can tell when it died and launch
// another: a request still 'thinking', 'minor' (its prototype on the way),
// 'reproducing' (#137), or approved or the team's without its issue yet,
// whose worker is gone (the server restarted mid-launch, the runner
// rebooted). `by`: who launched it, for the request's activity (#132).
const worker = trackedWorker({
  name: 'domains/portal/worker',
  area: 'portal',
  subject: (n) => `el pedido P-${n}`,
  list: listRequests,
  pending: (r) => r.status === 'thinking' || r.status === 'minor' || r.status === 'reproducing' || needsIssue(r),
  noteLaunch: (n, pid, by) => updateRequest(n, (r) => {
    r.worker = { pid, since: new Date().toISOString() };
    addEvent(r, { kind: 'worker', by, pid });
  }),
});

export const launchPortalWorker = worker.launch;
export const sweepPortalRequests = worker.sweep;
