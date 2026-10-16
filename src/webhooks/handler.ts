// One webhook event's run, in its own process — started by the webhook server
// (server.ts) the moment the event arrives, instead of waiting for a whole
// tick. Runs tick.ts's flows for the event's scope only (runScoped): the
// issue or PR it's about, the flows that event can move. The cron tick keeps
// running everything as the reconciliation pass. See docs/DESIGN.md §14.
import { createHash } from 'node:crypto';
import { loadRepos } from '../core/repos.js';
import { withActiveRepo } from '../core/repo-context.js';
import { getPrHead } from '../core/github.js';
import { tryLockResource, unlockResource } from '../core/locks.js';
import { log } from '../core/logger.js';
import { issueFromSliceBranch } from '../slices/index.js';
import { runScoped, type Scope } from '../tick.js';

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

async function main(): Promise<void> {
  const entry = (await loadRepos()).find((r) => r.productRepo === request.repo);
  if (!entry) throw new Error(`${request.repo} no está en repos.json`);
  await withActiveRepo(entry, async () => {
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

main().catch((error) => {
  log.error('handler de evento falló', error);
  process.exitCode = 1;
});
