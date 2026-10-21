// One meeting read by ronin, in its own process (#62): started by the server
// when someone uploads its notes or asks again (launchMeetingWorker), or by
// the tick when the one before died. Reading waits for a slot of the
// runner's shared quota like any other agent run, and holds the meeting's
// lock throughout, so two workers never read the same meeting.
import { concurrencyFor, config } from '../../platform/config/config.js';
import { tryLockResource, unlockResource, withSlots } from '../../platform/locks/locks.js';
import { errorLine, getMeeting, noteEvent, updateMeeting } from './meetings.js';
import { readMeeting } from './read.js';
import { runWorker, withProductRepo, workerRequest } from '../../platform/workers/run.js';

const { number } = workerRequest<{ number?: number }>();

async function main(): Promise<void> {
  const meeting = number ? await getMeeting(number) : undefined;
  if (!meeting || !(meeting.status === 'pending' || meeting.status === 'reading')) return;
  const n = meeting.number;
  await withProductRepo(meeting.repo, async () => {
    const resource = `meeting-${n}`;
    if (!(await tryLockResource(resource))) return;
    try {
      await updateMeeting(n, (m) => {
        m.worker = { pid: process.pid, since: new Date().toISOString() };
      });
      await withSlots('meeting-read', concurrencyFor(), {}, () => readMeeting(n), `reunión R-${n}`);
    } finally {
      await unlockResource(resource);
    }
  });
}

runWorker(`meeting-worker R-${number}`, main, async (error) => {
  if (number) await noteEvent(number, { kind: 'failed', error: errorLine(error) });
});
