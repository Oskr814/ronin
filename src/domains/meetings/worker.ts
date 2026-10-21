// One meeting read by ronin, in its own process (#62): started by the server
// when someone uploads its notes or asks again (launchMeetingWorker), or by
// the tick when the one before died. Reading waits for a slot of the
// runner's shared quota like any other agent run, and holds the meeting's
// lock throughout, so two workers never read the same meeting.
import { concurrencyFor, config } from '../../core/config.js';
import { tryLockResource, unlockResource, withSlots } from '../../core/locks.js';
import { log } from '../../core/logger.js';
import { withActiveRepo } from '../../core/repo-context.js';
import { loadRepos } from '../../core/repos.js';
import { errorLine, getMeeting, noteEvent, updateMeeting } from './meetings.js';
import { readMeeting } from './read.js';

const { number } = JSON.parse(process.argv[2] ?? '{}') as { number?: number };

async function main(): Promise<void> {
  const meeting = number ? await getMeeting(number) : undefined;
  if (!meeting || !(meeting.status === 'pending' || meeting.status === 'reading')) return;
  const entry = (await loadRepos()).find((r) => r.productRepo === meeting.repo);
  if (!entry) throw new Error(`${meeting.repo} no está en repos.json`);
  const n = meeting.number;
  await withActiveRepo(entry, async () => {
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

main().catch(async (error) => {
  log.error(`meeting-worker R-${number} falló`, error);
  if (number) await noteEvent(number, { kind: 'failed', error: errorLine(error) }).catch(() => {});
  process.exitCode = 1;
});
