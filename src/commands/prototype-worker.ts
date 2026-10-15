// One prototype in its own process — started by the tick (see prototype.ts's
// launchPrototypeWorker), never inside it: bringing an app up and drawing
// the after takes many minutes. Takes the request as a JSON argument, waits
// for the per-repo prototype lock, and answers the comment that asked for it.
import { loadRepos } from '../core/repos.js';
import { withActiveRepo } from '../core/repo-context.js';
import { replyToComment } from '../core/github.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import {
  releasePrototypeLock,
  renderPrototypeComment,
  renderPrototypeFailed,
  runPrototype,
  waitForPrototypeLock,
  type PrototypeWorkerRequest,
} from './prototype.js';

const request = JSON.parse(process.argv[2] ?? '{}') as PrototypeWorkerRequest;

async function reply(body: string): Promise<void> {
  await replyToComment(request.issueNumber, { id: request.commentId, kind: 'issue' }, body)
    .catch((error) => log.error(`prototipo issue #${request.issueNumber}: no se pudo responder el comentario`, error));
}

async function main(): Promise<void> {
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    if (!(await waitForPrototypeLock())) {
      await reply(renderPrototypeFailed('llevo horas esperando que termine otro prototipo en este repo. Volvé a pedirlo más tarde.'));
      return;
    }
    try {
      const result = await runPrototype(request);
      await reply(renderPrototypeComment(result, config.githubLogin));
      log.info(`prototipo issue #${request.issueNumber}: publicado`);
    } catch (error) {
      log.error(`prototipo issue #${request.issueNumber} falló`, error);
      await reply(renderPrototypeFailed((error as Error).message));
    } finally {
      await releasePrototypeLock();
    }
  });
}

main().catch((error) => {
  log.error('prototype-worker falló', error);
  process.exitCode = 1;
});
