// One /preview (or /preview stop, or an update to a new commit) in its own
// process — started by the tick or an event handler (see preview.ts's
// launchPreviewWorker), never inside them: bringing an app up takes minutes.
// Takes the request as a JSON argument, holds the PR's preview lock while it
// runs, and answers the comment that asked for it — or the PR, for an
// update nobody asked for. Asked from the tablero (#446), it answers in its
// command instead, and so do the updates of a preview asked from there.
import { commentOnSpecPr, getPrHead, replyToComment } from '@platform/github/github.js';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import {
  acquirePreviewLock,
  releasePreviewLock,
  renderPreviewFailed,
  renderPreviewReady,
  renderPreviewStarting,
  renderPreviewUpdated,
  renderPreviewUpdateFailed,
  previewOrigin,
  startPreview,
  stopPreview,
  updatePreview,
  type PreviewWorkerRequest,
} from './preview.js';
import { runWorker, withProductRepo, workerRequest } from '@platform/workers/run.js';
import { getDb } from '@platform/db/db.js';
import { createCommand, finishCommand, noteCommand, startCommand } from '../commands/store.js';

const request = workerRequest<PreviewWorkerRequest>();

// The command it answers in: the one asked from the tablero, or, for an
// update of a preview asked from there, one of ronin's own made on its
// first answer.
let command: string | null = request.action !== 'update' ? request.command ?? null : null;
// What went wrong, if something did: how its command ends.
let failure: string | null = null;

async function reply(body: string, failed = false): Promise<void> {
  if (failed) failure = body;
  const db = getDb();
  try {
    if (request.action === 'update' && db && !command && (await previewOrigin(request.prNumber)) === 'tablero') {
      command = (await createCommand(db, { repo: request.repo, number: request.prNumber, kind: 'preview-update', requestedBy: config.githubLogin })).command.id;
      await startCommand(db, command);
    }
    if (command && db) await noteCommand(db, command, body);
    else if (request.action === 'update') await commentOnSpecPr(request.prNumber, body);
    else if (request.comment) await replyToComment(request.prNumber, request.comment, body);
  } catch (error) {
    log.error(`preview PR #${request.prNumber}: no se pudo responder`, error);
  }
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
      await reply(renderPreviewUpdateFailed(error as Error), true);
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
    await reply('Este PR ya no está abierto, no levanto una preview.', true);
    return;
  }
  // Same rule as everywhere else in ronin: a fork's code never runs here.
  if (pr.isCrossRepository) {
    await reply('No levanto previews de PRs que vienen de un fork: su código no corre en el runner.', true);
    return;
  }
  await reply(renderPreviewStarting(pr.headRefOid, config.previewPrepareData));
  await reply(renderPreviewReady(await startPreview(request.prNumber, pr, request.args, command ? { origin: 'tablero' } : {}), config.githubLogin, config.previewTtlMinutes));
}

async function main(): Promise<void> {
  const db = getDb();
  if (command && db) await startCommand(db, command).catch((error) => log.error(`preview PR #${request.prNumber}: no se pudo marcar el comando ${command} como empezado`, error));
  try {
    await withProductRepo(request.repo, async () => {
      if (!(await acquirePreviewLock(request.prNumber))) {
        // The update that holds the lock reads the PR's head again before it
        // lets go (see update), so this commit isn't lost.
        if (request.action !== 'update') await reply('Ya estoy trabajando en la preview de este PR. Esperá a que termine y volvé a pedirla.', true);
        return;
      }
      try {
        await run();
      } catch (error) {
        log.error(`preview PR #${request.prNumber} falló`, error);
        await reply(renderPreviewFailed(error as Error), true);
      } finally {
        await releasePreviewLock(request.prNumber);
      }
    });
  } catch (error) {
    failure ??= (error as Error).message;
    throw error;
  } finally {
    if (command && db) await finishCommand(db, command, failure ? { error: failure } : {}).catch((error) => log.error(`preview PR #${request.prNumber}: no se pudo cerrar el comando ${command}`, error));
  }
}

runWorker('preview-worker', main);
