import { trackedWorker } from '../../platform/workers/tracked.js';
import { addEvent, listMeetings, updateMeeting } from './meetings.js';

// The worker that reads a meeting (worker.ts), its pid noted on the meeting
// so the tick can tell when it died and launch another: a meeting still to
// read whose worker is gone (the server restarted mid-launch, the runner
// rebooted). `by`: who launched it, for the meeting's activity.
const worker = trackedWorker({
  name: 'domains/meetings/worker',
  area: 'reuniones',
  subject: (n) => `R-${n}`,
  list: listMeetings,
  pending: (m) => m.status === 'pending' || m.status === 'reading',
  noteLaunch: (n, pid, by) => updateMeeting(n, (m) => {
    m.worker = { pid, since: new Date().toISOString() };
    addEvent(m, { kind: 'worker', by, pid });
  }),
});

export const launchMeetingWorker = worker.launch;
export const sweepMeetings = worker.sweep;

// Someone asks again for a meeting whose reading failed: back to 'pending',
// for the caller to launch its worker. False if it hadn't failed.
export function retryMeeting(n: number, by: string): Promise<boolean> {
  return updateMeeting(n, (m) => {
    if (m.status !== 'failed') return false;
    m.status = 'pending';
    addEvent(m, { kind: 'retried', by });
    return true;
  });
}
