// One /preview (or /preview stop) in its own process — started by the tick
// (see preview.ts's launchPreviewWorker), never inside it: bringing an app up
// takes minutes. Takes the request as a JSON argument, holds the PR's preview
// lock while it runs, and answers the comment that asked for it.
import { loadRepos } from './repos.js';
import { withActiveRepo } from './repo-context.js';
import { getPrHead, replyToComment } from './github.js';
import { config } from './config.js';
import { log } from './logger.js';
import {
  acquirePreviewLock,
  releasePreviewLock,
  renderPreviewFailed,
  renderPreviewReady,
  renderPreviewStarting,
  startPreview,
  stopPreview,
  type PreviewWorkerRequest,
} from './preview.js';

const request = JSON.parse(process.argv[2] ?? '{}') as PreviewWorkerRequest;

async function reply(body: string): Promise<void> {
  await replyToComment(request.prNumber, request.comment, body)
    .catch((error) => log.error(`preview PR #${request.prNumber}: no se pudo responder el comentario`, error));
}

async function run(): Promise<void> {
  if (request.action === 'stop') {
    await reply((await stopPreview(request.prNumber)) ? '🛑 Bajé la preview de este PR.' : 'Este PR no tiene una preview levantada.');
    return;
  }
  const pr = await getPrHead(request.prNumber);
  if (pr.state !== 'OPEN') {
    await reply('Este PR ya no está abierto, no levanto una preview.');
    return;
  }
  // Same rule as everywhere else in ronin: a fork's code never runs here.
  if (pr.isCrossRepository) {
    await reply('No levanto previews de PRs que vienen de un fork: su código no corre en el runner.');
    return;
  }
  await reply(renderPreviewStarting(pr.headRefOid, config.previewPrepareData));
  await reply(renderPreviewReady(await startPreview(request.prNumber, pr, request.args), config.githubLogin, config.previewTtlMinutes));
}

async function main(): Promise<void> {
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    if (!(await acquirePreviewLock(request.prNumber))) {
      await reply('Ya estoy trabajando en la preview de este PR. Esperá a que termine y volvé a pedirla.');
      return;
    }
    try {
      await run();
    } catch (error) {
      log.error(`preview PR #${request.prNumber} falló`, error);
      await reply(renderPreviewFailed(error as Error));
    } finally {
      await releasePreviewLock(request.prNumber);
    }
  });
}

main().catch((error) => {
  log.error('preview-worker falló', error);
  process.exitCode = 1;
});
