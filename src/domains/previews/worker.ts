// One /preview (or /preview stop, or an update to a new commit) in its own
// process — started by the tick or an event handler (see preview.ts's
// launchPreviewWorker), never inside them: bringing an app up takes minutes.
// Takes the request as a JSON argument, holds the PR's preview lock while it
// runs, and answers the comment that asked for it — or the PR, for an
// update nobody asked for.
import { commentOnSpecPr, getPrHead, replyToComment } from '../../platform/github/github.js';
import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import {
  acquirePreviewLock,
  releasePreviewLock,
  renderPreviewFailed,
  renderPreviewReady,
  renderPreviewStarting,
  renderPreviewUpdated,
  renderPreviewUpdateFailed,
  startPreview,
  stopPreview,
  updatePreview,
  type PreviewWorkerRequest,
} from './preview.js';
import { runWorker, withProductRepo, workerRequest } from '../../platform/workers/run.js';

const request = workerRequest<PreviewWorkerRequest>();

async function reply(body: string): Promise<void> {
  const answer = request.action === 'update'
    ? commentOnSpecPr(request.prNumber, body)
    : replyToComment(request.prNumber, request.comment, body);
  await answer.catch((error) => log.error(`preview PR #${request.prNumber}: no se pudo responder`, error));
}

// A push that lands while an update runs finds the lock taken: once this one
// is done, the PR's head is read again and one more pass catches up with
// it. Bounded, so a PR pushed to nonstop leaves the rest to the sweep.
const MAX_UPDATE_PASSES = 3;

async function update(): Promise<void> {
  for (let pass = 0; pass < MAX_UPDATE_PASSES; pass++) {
    const pr = await getPrHead(request.prNumber);
    if (pr.state !== 'OPEN' || pr.isCrossRepository) return;
    let outcome;
    try {
      outcome = await updatePreview(request.prNumber, pr);
    } catch (error) {
      log.error(`preview PR #${request.prNumber}: no se pudo actualizar`, error);
      await reply(renderPreviewUpdateFailed(error as Error));
      return;
    }
    if (!outcome || outcome.kind === 'current') return;
    await reply(renderPreviewUpdated(outcome));
  }
}

async function run(): Promise<void> {
  if (request.action === 'update') {
    await update();
    return;
  }
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
  await withProductRepo(request.repo, async () => {
    if (!(await acquirePreviewLock(request.prNumber))) {
      // The update that holds the lock reads the PR's head again before it
      // lets go (see update), so this commit isn't lost.
      if (request.action !== 'update') await reply('Ya estoy trabajando en la preview de este PR. Esperá a que termine y volvé a pedirla.');
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

runWorker('preview-worker', main);
