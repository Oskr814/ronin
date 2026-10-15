// One /resolve-conflicts in its own process — started by the tick (see
// conflicts.ts's launchConflictsWorker), never inside it: an agent resolving
// conflicts and running tests takes minutes. Takes the request as a JSON
// argument, holds the PR's lock while it runs, and answers the comment that
// asked for it.
import { loadRepos } from '../core/repos.js';
import { withActiveRepo } from '../core/repo-context.js';
import { getPrHead, replyToComment } from '../core/github.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import {
  acquireConflictsLock,
  releaseConflictsLock,
  renderConflictsFailed,
  renderConflictsOutcome,
  renderConflictsStarting,
  resolveConflicts,
  type ConflictsWorkerRequest,
} from './conflicts.js';

const request = JSON.parse(process.argv[2] ?? '{}') as ConflictsWorkerRequest;

async function reply(body: string): Promise<void> {
  await replyToComment(request.prNumber, request.comment, body)
    .catch((error) => log.error(`conflictos PR #${request.prNumber}: no se pudo responder el comentario`, error));
}

async function run(): Promise<void> {
  const pr = await getPrHead(request.prNumber);
  if (pr.state !== 'OPEN') {
    await reply('Este PR ya no está abierto, no resuelvo sus conflictos.');
    return;
  }
  // A fork's branch isn't ronin's to push to, and its code never runs here.
  if (pr.isCrossRepository) {
    await reply('No resuelvo conflictos de PRs que vienen de un fork: no puedo subir a su rama.');
    return;
  }
  await reply(renderConflictsStarting(pr.baseRefName));
  const outcome = await resolveConflicts(request.prNumber, pr);
  log.info(`conflictos PR #${request.prNumber}: ${outcome.kind}`);
  await reply(renderConflictsOutcome(outcome, config.githubLogin));
}

async function main(): Promise<void> {
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    if (!(await acquireConflictsLock(request.prNumber))) {
      await reply('Ya estoy resolviendo los conflictos de este PR. Esperá a que termine.');
      return;
    }
    try {
      await run();
    } catch (error) {
      log.error(`conflictos PR #${request.prNumber} falló`, error);
      await reply(renderConflictsFailed(error as Error));
    } finally {
      await releaseConflictsLock(request.prNumber);
    }
  });
}

main().catch((error) => {
  log.error('conflicts-worker falló', error);
  process.exitCode = 1;
});
