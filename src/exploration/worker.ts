// One exploration run in its own process — started by the tick (see
// exploration/flow.ts's launchExploreWorker), never inside it. Takes the
// request as a JSON argument, holds the per-repo exploration lock while it
// runs, and answers the /explore comment that asked for it, if any. The
// same process redoes the after images reviewers asked for, which also need
// the app up.
import { loadRepos } from '../core/repos.js';
import { withActiveRepo } from '../core/repo-context.js';
import { replyToComment } from '../core/github.js';
import { log } from '../core/logger.js';
import {
  acquireExploreLock,
  exploreAndPublish,
  reactToTrigger,
  redoAndPublish,
  releaseExploreLock,
  renderRunReply,
  type ExploreWorkerRequest,
} from './flow.js';

const request = JSON.parse(process.argv[2] ?? '{}') as ExploreWorkerRequest;

async function main(): Promise<void> {
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    if (!(await acquireExploreLock())) {
      log.info(`exploración ${request.appName}: ya hay otra corrida en este repo, no arranco`);
      return;
    }
    if (request.redo) {
      try {
        await redoAndPublish(request.redo);
      } catch (error) {
        log.error(`exploración: rehacer los después del PR #${request.redo.prNumber} falló`, error);
      } finally {
        await releaseExploreLock();
      }
      return;
    }
    try {
      const run = await exploreAndPublish({
        appName: request.appName,
        ...(request.maxFunctions ? { maxFunctions: request.maxFunctions } : {}),
        ...(request.until ? { shouldContinue: () => Date.now() < Date.parse(request.until!) } : {}),
      });
      log.info(`exploración ${request.appName}: corrida ${run.summary.runId} publicada en el PR #${run.prNumber}`);
      if (request.trigger) {
        await replyToComment(request.trigger.issueNumber, { id: request.trigger.commentIds[0], kind: 'issue' }, renderRunReply(request.appName, run));
      }
    } catch (error) {
      log.error(`exploración ${request.appName} falló`, error);
      if (request.trigger) {
        await replyToComment(
          request.trigger.issueNumber,
          { id: request.trigger.commentIds[0], kind: 'issue' },
          `No pude completar la exploración de \`${request.appName}\`: ${(error as Error).message.split('\n')[0].slice(0, 300)}. El detalle está en el log del runner.`,
        ).catch(() => {});
      }
    } finally {
      // Reacted to on success and failure alike: a failed run is answered,
      // not retried every tick at the cost of another hour of agent time.
      await reactToTrigger(request.trigger);
      await releaseExploreLock();
    }
  });
}

main().catch((error) => {
  log.error('explore-worker falló', error);
  process.exitCode = 1;
});
