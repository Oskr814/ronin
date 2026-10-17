// One portal request worked by ronin, in its own process (#114): started by
// the server when the person writes (launchPortalWorker), or by the tick
// when the one before died. Reading it waits for a slot of the runner's
// shared quota like any other agent run; a small change then waits for the
// repo's prototype lock (one app stack at a time, shared with the issues'
// /prototype) and gets its prototype. Holds the request's lock throughout,
// so two workers never work the same request.
import { config } from '../core/config.js';
import { tryLockResource, unlockResource, withSlots } from '../core/locks.js';
import { log } from '../core/logger.js';
import { withActiveRepo } from '../core/repo-context.js';
import { loadRepos } from '../core/repos.js';
import { releasePrototypeLock, waitForPrototypeLock } from '../commands/prototype.js';
import { classifyRequest } from './classify.js';
import { prototypeRequest } from './prototype.js';
import { addRoninMessage, getRequest, updateRequest } from './requests.js';

const { number } = JSON.parse(process.argv[2] ?? '{}') as { number?: number };

async function main(): Promise<void> {
  const request = number ? await getRequest(number) : undefined;
  if (!request || (request.status !== 'thinking' && request.status !== 'minor')) return;
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    const resource = `portal-${request.number}`;
    if (!(await tryLockResource(resource))) return;
    const claim = () => updateRequest(request.number, (r) => {
      r.worker = { pid: process.pid, since: new Date().toISOString() };
    });
    try {
      if (request.status === 'thinking') {
        await claim();
        await withSlots('portal-request', config.tickConcurrency, {}, () => classifyRequest(request.number), `pedido P-${request.number}`);
      }
      if ((await getRequest(request.number))?.status !== 'minor') return;
      await claim();
      if (!(await waitForPrototypeLock())) {
        await updateRequest(request.number, (r) => {
          addRoninMessage(r, 'Sigo esperando turno para armar tu prototipo: hay otros en curso. Lo intento de nuevo en un rato.');
          delete r.worker;
        });
        return;
      }
      try {
        await prototypeRequest(request.number);
      } finally {
        await releasePrototypeLock();
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
