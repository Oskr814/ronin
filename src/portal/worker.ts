// One portal request read by ronin, in its own process (#114): started by
// the server when the person writes (launchPortalWorker), or by the tick
// when the one before died. Waits for a slot of the runner's shared quota
// like any other agent run, and holds the request's lock meanwhile, so two
// workers never read the same request.
import { config } from '../core/config.js';
import { tryLockResource, unlockResource, withSlots } from '../core/locks.js';
import { log } from '../core/logger.js';
import { withActiveRepo } from '../core/repo-context.js';
import { loadRepos } from '../core/repos.js';
import { classifyRequest } from './classify.js';
import { getRequest, updateRequest } from './requests.js';

const { number } = JSON.parse(process.argv[2] ?? '{}') as { number?: number };

async function main(): Promise<void> {
  const request = number ? await getRequest(number) : undefined;
  if (!request || request.status !== 'thinking') return;
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    const resource = `portal-${request.number}`;
    if (!(await tryLockResource(resource))) return;
    try {
      await updateRequest(request.number, (r) => {
        r.worker = { pid: process.pid, since: new Date().toISOString() };
      });
      await withSlots('portal-request', config.tickConcurrency, {}, () => classifyRequest(request.number), `pedido P-${request.number}`);
    } finally {
      await unlockResource(resource);
    }
  });
}

main().catch((error) => {
  log.error(`portal-worker P-${number} falló`, error);
  process.exitCode = 1;
});
