// One webhook event's run, in its own process — started the moment the
// event arrives, instead of waiting for a whole tick: by the job queue's
// runner (apps/api/jobs/runner.ts) with DATABASE_URL, else by the server (github.ts). Runs tick.ts's flows for the event's scope only (runScoped): the
// issue or PR it's about, the flows that event can move. The cron tick keeps
// running everything as the reconciliation pass. See docs/DESIGN.md §14.
import { createHash } from 'node:crypto';
import { config } from '../../../platform/config/config.js';
import { loadRepos } from '../../../platform/config/repos.js';
import { withActiveRepo } from '../../../platform/agents/repo-context.js';
import { getPrHead } from '../../../platform/github/github.js';
import { tryLockResource, unlockResource } from '../../../platform/locks/locks.js';
import { log } from '../../../platform/logger.js';
import { issueFromSliceBranch } from '../../../domains/slices/index.js';
import { launchPreviewUpdates } from '../../../domains/previews/index.js';
import { runScoped, type Scope } from '../tick/tick.js';
import { runAsJob } from '../jobs/child.js';

export interface EventHandlerRequest {
  repo: string;
  scope: Scope;
  // When the server got the event (epoch ms), to log how long it took to act.
  receivedAt: number;
}

const request = JSON.parse(process.argv[2] ?? '{}') as EventHandlerRequest;

// A comment on a PR arrives without its branch (see events.ts): a slice PR's
// issue is added here, so the run takes — and waits for — the issue, which is
// what the tick's job for that PR holds.
async function withSliceIssues(scope: Scope): Promise<Scope> {
  const resources = [...scope.resources];
  if (!scope.flows.some((flow) => flow === 'issues' || flow === 'idle-commands')) return scope;
  for (const resource of scope.resources) {
    const match = resource.match(/^pr-(\d+)$/);
    if (!match) continue;
    const pr = Number(match[1]);
    if (resources.some((r) => r.startsWith('issue-'))) continue;
    try {
      const issue = issueFromSliceBranch((await getPrHead(pr)).headRefName);
      if (issue !== null) resources.push(`issue-${issue}`);
    } catch (error) {
      log.info(`evento: no se pudo leer la rama del PR #${pr}, sigue sin su issue: ${(error as Error).message}`);
    }
  }
  return { ...scope, resources };
}

// The cap on the whole event (EVENT_HANDLER_TIMEOUT_MINUTES). The handler is
// launched detached, so it leads its own process group: the signal goes to
// the group, which takes the `claude -p` it's running too. The workers it
// launched lead groups of their own and keep going. Its locks and run
// record carry its pid, so the next process takes the locks over and the
// dashboard shows the run as cut.
function capRun(timeoutMs: number): void {
  setTimeout(() => {
    log.error(`handler de evento: pasaron ${Math.round(timeoutMs / 60_000)} min (EVENT_HANDLER_TIMEOUT_MINUTES), lo corto con lo que esté corriendo`);
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      process.kill(process.pid, 'SIGTERM');
    }
  }, timeoutMs).unref();
}

async function main(): Promise<void> {
  capRun(config.eventHandlerTimeoutMs);
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
    // Before waiting for anything: it only launches workers, which hold
    // their own lock, and the push that sent this event is often ronin's own
    // issue job, which still holds the issue it would wait for.
    if (request.scope.flows.includes('previews')) {
      const prs = request.scope.resources.flatMap((r) => (/^pr-\d+$/.test(r) ? [Number(r.slice(3))] : []));
      await launchPreviewUpdates(prs).catch((error) => log.error('evento: no se pudieron lanzar las actualizaciones de previews', error));
    }
    const scope = await withSliceIssues(request.scope);
    // At most one handler waiting per scope: the one already waiting reads
    // everything once it gets its turn, this event included.
    const key = createHash('sha1').update(JSON.stringify([[...scope.flows].sort(), [...scope.resources].sort()])).digest('hex').slice(0, 12);
    const waiting = `waiting-${key}`;
    if (!(await tryLockResource(waiting))) {
      log.info(`evento ${scope.resources.join(', ')}: ya hay otro esperando su turno para lo mismo, este no hace falta`);
      return;
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await unlockResource(waiting);
    };
    try {
      await runScoped(scope, async () => {
        await release();
        log.metric('event_start', { repo: request.repo, flows: scope.flows, resources: scope.resources, delayMs: Date.now() - request.receivedAt });
      });
    } finally {
      await release();
    }
  });
}

// A job of the queue (#235, stage 3) when the runner started it: its lease
// is renewed while it runs, and it's marked done or failed.
runAsJob(main).catch((error) => {
  log.error('handler de evento falló', error);
  process.exitCode = 1;
});
