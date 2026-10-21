import { launchWorker } from '../../core/worker-launch.js';
import { log } from '../../core/logger.js';
import { addEvent, listMeetings, updateMeeting } from './meetings.js';

// Starts the worker that reads a meeting (worker.ts), and notes its pid on
// the meeting so the tick can tell when it died. `by`: who launched it, for
// the meeting's activity.
export async function launchMeetingWorker(n: number, by: 'server' | 'tick' = 'server'): Promise<void> {
  const pid = launchWorker('domains/meetings/worker', { number: n });
  if (pid) await updateMeeting(n, (m) => {
    m.worker = { pid, since: new Date().toISOString() };
    addEvent(m, { kind: 'worker', by, pid });
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

// The tick's reconciliation: a meeting still to read whose worker is gone
// (the server restarted mid-launch, the runner rebooted) gets a new one.
export async function sweepMeetings(now = Date.now(), launch: (n: number, by: 'tick') => Promise<void> = launchMeetingWorker): Promise<void> {
  for (const meeting of await listMeetings()) {
    if (!(meeting.status === 'pending' || meeting.status === 'reading')) continue;
    if (meeting.worker && (alive(meeting.worker.pid) || now - Date.parse(meeting.worker.since) < GRACE_MS)) continue;
    if (!meeting.worker && now - Date.parse(meeting.updatedAt) < GRACE_MS) continue;
    log.info(`reuniones: R-${meeting.number} quedó sin quien la lea; lanzo otro worker`);
    await launch(meeting.number, 'tick').catch((error) => log.error(`reuniones: no se pudo relanzar R-${meeting.number}`, error));
  }
}

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
