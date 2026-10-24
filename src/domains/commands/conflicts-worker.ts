// One /resolve-conflicts in its own process — started by the tick (see
// conflicts.ts's launchConflictsWorker), never inside it: an agent resolving
// conflicts and running tests takes minutes. Takes the request as a JSON
// argument, holds the PR's lock while it runs, and answers the comment that
// asked for it — or its command, asked from the tablero (#446).
import { getPrHead, replyToComment } from '@platform/github/github.js';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import {
  acquireConflictsLock,
  releaseConflictsLock,
  renderConflictsFailed,
  renderConflictsOutcome,
  renderConflictsStarting,
  resolveConflicts,
  type ConflictsWorkerRequest,
} from './conflicts.js';
import { runWorker, withProductRepo, workerRequest } from '@platform/workers/run.js';
import { answerer } from '@platform/commands/answer.js';

const request = workerRequest<ConflictsWorkerRequest>();

const answer = answerer(request.command, (body) => (request.comment ? replyToComment(request.prNumber, request.comment, body) : Promise.resolve()), `conflictos PR #${request.prNumber}`);
const reply = (body: string, failed = false) => answer.say(body, failed);

async function run(): Promise<void> {
  const pr = await getPrHead(request.prNumber);
  if (pr.state !== 'OPEN') {
    await reply('Este PR ya no está abierto, no resuelvo sus conflictos.', true);
    return;
  }
  // A fork's branch isn't ronin's to push to, and its code never runs here.
  if (pr.isCrossRepository) {
    await reply('No resuelvo conflictos de PRs que vienen de un fork: no puedo subir a su rama.', true);
    return;
  }
  await reply(renderConflictsStarting(pr.baseRefName));
  const outcome = await resolveConflicts(request.prNumber, pr);
  log.info(`conflictos PR #${request.prNumber}: ${outcome.kind}`);
  await reply(renderConflictsOutcome(outcome, config.githubLogin), outcome.kind === 'branch-moved' || outcome.kind === 'unresolved');
}

async function main(): Promise<void> {
  await answer.start();
  try {
    await withProductRepo(request.repo, async () => {
      if (!(await acquireConflictsLock(request.prNumber))) {
        await reply('Ya estoy resolviendo los conflictos de este PR. Esperá a que termine.', true);
        return;
      }
      try {
        await run();
      } catch (error) {
        log.error(`conflictos PR #${request.prNumber} falló`, error);
        await reply(renderConflictsFailed(error as Error), true);
      } finally {
        await releaseConflictsLock(request.prNumber);
      }
    });
  } finally {
    await answer.done();
  }
}

runWorker('conflicts-worker', main);
