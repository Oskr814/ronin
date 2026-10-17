// One portal request worked by ronin, in its own process (#114): started by
// the server when the person writes or decides (launchPortalWorker), or by
// the tick when the one before died. Reading it waits for a slot of the
// runner's shared quota like any other agent run; a small change then waits
// for the repo's prototype lock (one app stack at a time, shared with the
// issues' /prototype) and gets its prototype. An approved one, or one the
// team takes, gets its issue in the product repo (issue.ts). Holds the
// request's lock throughout, so two workers never work the same request.
import { config } from '../core/config.js';
import { tryLockResource, unlockResource, withSlots } from '../core/locks.js';
import { log } from '../core/logger.js';
import { withActiveRepo } from '../core/repo-context.js';
import { loadRepos } from '../core/repos.js';
import { releasePrototypeLock, waitForPrototypeLock } from '../commands/prototype.js';
import { classifyRequest } from './classify.js';
import { needsIssue, openPortalIssue } from './issue.js';
import { prototypeRequest } from './prototype.js';
import { addRoninMessage, getRequest, updateRequest } from './requests.js';

const { number } = JSON.parse(process.argv[2] ?? '{}') as { number?: number };

const claim = (n: number) => updateRequest(n, (r) => {
  r.worker = { pid: process.pid, since: new Date().toISOString() };
});

async function prototype(n: number): Promise<void> {
  await claim(n);
  if (!(await waitForPrototypeLock())) {
    await updateRequest(n, (r) => {
      addRoninMessage(r, 'Sigo esperando turno para armar tu prototipo: hay otros en curso. Lo intento de nuevo en un rato.');
      delete r.worker;
    });
    return;
  }
  try {
    await prototypeRequest(n);
  } finally {
    await releasePrototypeLock();
  }
}

async function main(): Promise<void> {
  const request = number ? await getRequest(number) : undefined;
  if (!request || !(request.status === 'thinking' || request.status === 'minor' || needsIssue(request))) return;
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  const n = request.number;
  await withActiveRepo(entry, async () => {
    const resource = `portal-${n}`;
    if (!(await tryLockResource(resource))) return;
    try {
      if (request.status === 'thinking') {
        await claim(n);
        await withSlots('portal-request', config.tickConcurrency, {}, () => classifyRequest(n), `pedido P-${n}`);
      }
      if ((await getRequest(n))?.status === 'minor') await prototype(n);
      // Approved, or the team's now: its issue.
      const now = await getRequest(n);
      if (now && needsIssue(now)) {
        await claim(n);
        await openPortalIssue(n);
      }
    } finally {
      await unlockResource(resource);
    }
  });
}

main().catch((error) => {
  log.error(`portal-worker P-${number} falló`, error);
  process.exitCode = 1;
});
