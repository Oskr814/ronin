import { linearIssuesFor, linearKey, resolveProject, updateIssue } from './linear-api.js';
import { readLocalState, withLocalStateLock, writeLocalState, type LinearPending } from '../state/local-state.js';
import { log } from '../logger.js';
import { activeRepo, withActiveRepo, type RepoEntry } from '../agents/repo-context.js';

// Putting the issues ronin opens in a Linear project (#101, entrega 3).
// GitHub stays the source: the issue is created there as always, and the
// sync creates it in Linear a little later — so the project (or cycle) is
// queued in the local state and applied once Linear has the issue, by the
// next tick, or right away by the server for an issue created from the
// dashboard. A repo without a Linear key queues nothing.
//
// Three kinds of issues get one:
// - created from the dashboard with a project or cycle chosen (projectId,
//   cycleId): applied as chosen;
// - opened by the exploration: the app's project in repos.json
//   (`linear.explorationProject`), if the issue has none yet;
// - a spec's tracking issue: the project of the issue the spec came from, if
//   it has one and the new issue has none yet.

// How long to wait for the sync before giving up on an issue.
const GIVE_UP_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;

export async function queueLinearAssignment(pending: Omit<LinearPending, 'since'>): Promise<void> {
  if (!linearKey(activeRepo())) return;
  if (!pending.projectId && !pending.cycleId && !pending.projectName && pending.fromIssue === undefined) return;
  await withLocalStateLock(async () => {
    const state = await readLocalState();
    state.linearPending = [...state.linearPending.filter((p) => p.number !== pending.number), { ...pending, since: new Date().toISOString() }];
    await writeLocalState(state);
  });
}

// An issue the exploration of `appName` opened: into the app's project, if
// repos.json names one. Never fails the exploration: an error is only logged.
export async function queueExplorationProject(appName: string, number: number): Promise<void> {
  const projectName = activeRepo().linear?.explorationProject?.[appName];
  if (!projectName) return;
  await queueLinearAssignment({ number, projectName }).catch((error) => log.error(`Linear: no se pudo encolar el proyecto de #${number}`, error));
}

type Outcome = 'done' | 'wait' | 'drop';

async function apply(key: string, pending: LinearPending, now: number): Promise<Outcome> {
  const repo = activeRepo();
  const numbers = [pending.number, ...(pending.fromIssue !== undefined ? [pending.fromIssue] : [])];
  const found = await linearIssuesFor(repo, key, numbers);
  const issue = found.get(pending.number);
  if (!issue?.uuid) {
    if (now - Date.parse(pending.since) > GIVE_UP_MS) {
      log.info(`Linear: #${pending.number} nunca apareció en Linear, no se le asigna proyecto`);
      return 'drop';
    }
    return 'wait';
  }
  const input: { projectId?: string; cycleId?: string } = {};
  if (pending.projectId) input.projectId = pending.projectId;
  if (pending.cycleId) input.cycleId = pending.cycleId;
  // Only into an issue without a project: someone may have put it in one already.
  if (!input.projectId && !issue.project) {
    if (pending.projectName) {
      const id = await resolveProject(key, pending.projectName);
      if (id) input.projectId = id;
      else log.info(`Linear: no hay un proyecto "${pending.projectName}" (linear.explorationProject en repos.json); #${pending.number} queda sin proyecto`);
    } else if (pending.fromIssue !== undefined) {
      const from = found.get(pending.fromIssue)?.project;
      if (from) input.projectId = from.id;
    }
  }
  if (Object.keys(input).length === 0) return 'drop';
  await updateIssue(key, issue.uuid, input);
  log.info(`Linear: ${issue.id} (#${pending.number})${input.projectId ? ' en su proyecto' : ''}${input.cycleId ? ' en su ciclo' : ''}`);
  return 'done';
}

// Applies every queued assignment Linear is ready for. Each on its own: one
// failing (Linear down, a project gone) never holds up the rest, and it's
// retried a few times before giving up.
export async function processLinearAssignments(now = Date.now()): Promise<void> {
  const key = linearKey(activeRepo());
  if (!key) return;
  const queued = (await readLocalState()).linearPending;
  if (queued.length === 0) return;
  const finished = new Set<number>();
  const failed = new Set<number>();
  for (const pending of queued) {
    try {
      const outcome = await apply(key, pending, now);
      if (outcome !== 'wait') finished.add(pending.number);
    } catch (error) {
      log.error(`Linear: no se pudo asignar #${pending.number}`, error);
      failed.add(pending.number);
    }
  }
  await withLocalStateLock(async () => {
    const state = await readLocalState();
    state.linearPending = state.linearPending.flatMap((p) => {
      if (finished.has(p.number)) return [];
      if (!failed.has(p.number)) return [p];
      const attempts = (p.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        log.info(`Linear: se deja de intentar asignar #${p.number} después de ${attempts} errores`);
        return [];
      }
      return [{ ...p, attempts }];
    });
    await writeLocalState(state);
  });
}

// The sync usually creates the Linear issue within seconds: for an issue
// created from the dashboard, try a few times over the next minutes, so the
// project shows up while the person is still looking. Whatever's left, the
// next tick applies.
const RETRY_S = [5, 15, 30, 60, 120, 300];
export function applyLinearSoon(entry: RepoEntry): void {
  for (const s of RETRY_S) {
    setTimeout(() => {
      withActiveRepo(entry, () => processLinearAssignments()).catch((error) => log.error('Linear: no se pudo asignar el issue nuevo', error));
    }, s * 1000).unref();
  }
}
