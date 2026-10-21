import { config } from '../../platform/config/config.js';
import { getNightlyExploration, setNightlyExploration } from '../../platform/state/local-state.js';
import { withActiveRepo, type RepoEntry } from '../../platform/agents/repo-context.js';
import { addDays, instantAt, wallClock } from '../../platform/config/timezone.js';
import { currentNight, parseNightWindow, upcomingNight, type NightWindow } from './schedule.js';
import { exploreWorkerBusy, launchExploreWorker, type ExploreWorkerRequest } from './flow.js';
import { CHARTERS, EXPLORATION_DIR, VIEWPORTS, parseInventory } from './memory.js';
import { listRunRecords, type ExplorationRunFunction, type ExplorationRunRecord, type ExplorationTrigger } from './run-log.js';
import type { RunSummary } from '../runs/data.js';
import { explorationReview, isExplorationPr, readBranchFile, type ExplorationPr, type Ficha } from './review.js';
import { DomainError } from '../../platform/errors.js';

// The dashboard's Exploraciones page (#155): one row per app a repo explores
// (`explore` in repos.json), with its repo's rolling exploration PR — one
// per repo (§11.7), so a repo with two apps shows the same PR on both — and
// whether ronin is exploring it right now. The PR's findings are reviewed on
// the app's page, which is the PR's item page (§15.12).

export interface ExploracionPr {
  number: number;
  id: string;
  title: string;
  url?: string;
}

export interface ExploracionRow {
  repo: string;
  app: string;
  pr: ExploracionPr | null;
  // A run of this app going on right now: since when, and what it's on.
  running: { since: string; step?: string; fn?: string } | null;
}

export interface FichaCounts {
  total: number;
  // Nobody said anything yet, or ronin answered what was said: someone decides.
  decidir: number;
  // A comment ronin hasn't answered yet.
  esperando: number;
  aprobadas: number;
  rechazadas: number;
}

export interface ExploracionListRow extends ExploracionRow {
  lastRun: { at: string; state: RunSummary['state'] } | null;
  // When the nightly exploration starts this app next.
  next: string | null;
  fichas: FichaCounts | null;
  error?: string;
}

// The agents of an exploration run (domains/explorations/run.ts). Not the ones that
// answer comments on the PR or redo an after image: those are about findings.
const EXPLORATION_TASKS = new Set(['explore-inventory', 'explore-function', 'explore-evaluate']);
// Their label starts with `app <name>`, and the one on a function goes on
// with ` → <function id>` (domains/explorations/prompts.ts).
const LABEL_RE = /^app ([\w.-]+)(?: → (.+))?$/;
export const isExplorationRun = (run: Pick<RunSummary, 'taskType'>) => EXPLORATION_TASKS.has(run.taskType);

export function runApp(run: Pick<RunSummary, 'taskType' | 'label'>): { app: string; fn?: string } | null {
  if (!isExplorationRun(run)) return null;
  const match = LABEL_RE.exec(run.label);
  return match ? { app: match[1], ...(match[2] ? { fn: match[2] } : {}) } : null;
}

const appRuns = (runs: RunSummary[], repo: string, app: string) => runs.filter((run) => run.repo === repo && runApp(run)?.app === app);

interface PrLike extends ExplorationPr {
  title: string;
  url?: string;
}

// The snapshot's rows: cheap, from what the snapshot already read. `live`:
// the apps whose worker is up by their record (liveRuns), since when — its
// first agent only starts once the app is up, minutes later.
export function exploracionRows(entries: RepoEntry[], prsByRepo: Map<string, PrLike[]>, runs: RunSummary[], live = new Map<string, string>()): ExploracionRow[] {
  return entries.flatMap((entry) => {
    const repo = entry.productRepo;
    const open = (prsByRepo.get(repo) ?? []).find(isExplorationPr);
    const pr = open ? { number: open.number, id: `${repo}#${open.number}`, title: open.title, ...(open.url ? { url: open.url } : {}) } : null;
    return (entry.explore ?? []).map((app) => {
      const agent = appRuns(runs, repo, app).filter((run) => run.state === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      const fn = agent && runApp(agent)?.fn;
      const since = live.get(`${repo}|${app}`);
      const running = agent ? { since: since ?? agent.startedAt, ...(agent.lastStep ? { step: agent.lastStep } : {}), ...(fn ? { fn } : {}) } : since ? { since } : null;
      return { repo, app, pr, running };
    });
  });
}

export function countFichas(fichas: Ficha[], ronin = config.githubLogin): FichaCounts {
  const counts: FichaCounts = { total: fichas.length, decidir: 0, esperando: 0, aprobadas: 0, rechazadas: 0 };
  const mention = new RegExp(`@${ronin}\\b`, 'i');
  for (const f of fichas) {
    if (f.estado === 'rechazado') counts.rechazadas++;
    else if (f.estado === 'aprobado' || f.estado === 'resuelto') counts.aprobadas++;
    else {
      // The same reading as explorations/review-actions.ts's waitingOnRonin.
      const last = f.comments[f.comments.length - 1];
      const waiting = last && last.author.toLowerCase() !== ronin.toLowerCase() && (!last.replyTo || mention.test(last.body));
      if (waiting) counts.esperando++;
      else counts.decidir++;
    }
  }
  return counts;
}

// The apps whose run's record says it's going and whose repo's lock is held
// (a record left `running` by a worker that died isn't), by `repo|app`.
export async function liveRuns(entries: RepoEntry[]): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.explore?.length || !(await withActiveRepo(entry, () => exploreWorkerBusy()).catch(() => false))) continue;
    for (const app of entry.explore) {
      const [last] = await listRunRecords(entry.productRepo, app, 1);
      if (last?.state === 'running') live.set(`${entry.productRepo}|${app}`, last.startedAt);
    }
  }
  return live;
}

// When the nightly exploration starts this app next: tonight's window, or
// right now while it's open and the app hasn't started yet, or tomorrow's
// once it has. Null when the window can't be read.
export function nextNightly(now: Date, window: NightWindow, timezone: string, lastNight: string | undefined): string {
  const tonight = currentNight(now, window, timezone);
  if (tonight) {
    if (lastNight !== tonight.night) return now.toISOString();
    return instantAt(addDays(tonight.night, 1), window.startMinutes, timezone).toISOString();
  }
  const { day, minutes } = wallClock(now, timezone);
  // Outside the window: it starts today, or tomorrow once today's start went by
  // (a window that ended this morning).
  const start = minutes < window.startMinutes ? day : addDays(day, 1);
  return instantAt(start, window.startMinutes, timezone).toISOString();
}

// GET /api/exploraciones: the rows with each PR's findings counted, the last
// run and the next one.
export async function exploracionList(entries: RepoEntry[], rows: ExploracionRow[], runs: RunSummary[], prsByRepo: Map<string, PrLike[]>, now = new Date()): Promise<ExploracionListRow[]> {
  let window: NightWindow | null = null;
  try {
    window = parseNightWindow(config.exploreNightWindow);
  } catch {
    window = null;
  }
  const nights = new Map<string, Record<string, string>>();
  for (const entry of entries) {
    if (entry.explore?.length) nights.set(entry.productRepo, await withActiveRepo(entry, () => getNightlyExploration()).catch(() => ({})));
  }
  return Promise.all(rows.map(async (row) => {
    const entry = entries.find((e) => e.productRepo === row.repo)!;
    const last = appRuns(runs, row.repo, row.app).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    let fichas: FichaCounts | null = null;
    let error: string | undefined;
    const pr = row.pr && (prsByRepo.get(row.repo) ?? []).find((p) => p.number === row.pr!.number);
    if (pr) {
      const review = await explorationReview(entry, pr);
      fichas = countFichas(review.fichas.filter((f) => f.app === row.app));
      if (review.error) error = review.error;
    }
    return {
      ...row,
      lastRun: last ? { at: last.startedAt, state: last.state } : null,
      next: window ? nextNightly(now, window, config.exploreTimezone, nights.get(row.repo)?.[row.app]) : null,
      fichas,
      ...(error ? { error } : {}),
    };
  }));
}

// ---------- Corridas (#155, 2/4)
// Each exploration run of an app: the worker's record (run-log.ts), with the
// agent runs it was made of (their cost and transcripts). Runs from before
// those records existed are put together from the agent runs alone, with
// less to say: no trigger, seed or findings.

export interface CorridaAgent {
  runId: string;
  taskType: string;
  fn?: string;
  state: RunSummary['state'];
  startedAt: string;
  durationMs?: number;
  costUsd?: number;
}

export interface Corrida {
  id: string;
  trigger: ExplorationTrigger | { kind: 'desconocido' };
  startedAt: string;
  endedAt?: string;
  state: 'running' | 'ok' | 'error' | 'cut';
  error?: string;
  runId?: string;
  seed?: number;
  prNumber?: number;
  functions: Array<Pick<ExplorationRunFunction, 'id' | 'status'> & Partial<ExplorationRunFunction>>;
  findings?: ExplorationRunRecord['findings'];
  discarded?: number;
  costUsd: number;
  agents: CorridaAgent[];
  // Put together from the agent runs: no record of its own.
  legacy?: boolean;
}

// Agent runs further apart than this are separate runs (an exploration's
// agents run one after another, with the app up in between).
const LEGACY_GAP_MS = 30 * 60_000;

const agentOf = (run: RunSummary): CorridaAgent => {
  const fn = runApp(run)?.fn;
  return {
    runId: run.runId, taskType: run.taskType, state: run.state, startedAt: run.startedAt,
    ...(fn ? { fn } : {}), ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
  };
};
const cost = (agents: CorridaAgent[]) => agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

// `busy`: whether the repo's exploration lock is held — a record still
// `running` without it was cut (the worker died before closing it).
export function buildCorridas(records: ExplorationRunRecord[], agentRuns: RunSummary[], busy: boolean, now = Date.now()): Corrida[] {
  const runs = [...agentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const used = new Set<string>();
  const corridas: Corrida[] = records.map((rec) => {
    const from = Date.parse(rec.startedAt);
    const to = rec.endedAt ? Date.parse(rec.endedAt) : now;
    const agents = runs.filter((r) => !used.has(r.runId) && Date.parse(r.startedAt) >= from && Date.parse(r.startedAt) <= to).map((r) => {
      used.add(r.runId);
      return agentOf(r);
    });
    const state = rec.state === 'running' && !busy ? 'cut' : rec.state;
    return {
      id: rec.id, trigger: rec.trigger, startedAt: rec.startedAt, state,
      ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
      ...(rec.error ? { error: rec.error } : {}),
      ...(rec.runId ? { runId: rec.runId } : {}),
      ...(rec.seed !== undefined ? { seed: rec.seed } : {}),
      ...(rec.prNumber ? { prNumber: rec.prNumber } : {}),
      functions: rec.functions ?? [...new Set(agents.flatMap((a) => (a.fn ? [a.fn] : [])))].map((id) => ({ id, status: 'explorada' as const })),
      ...(rec.findings ? { findings: rec.findings } : {}),
      ...(rec.discarded !== undefined ? { discarded: rec.discarded } : {}),
      costUsd: cost(agents),
      agents,
    };
  });

  const groups: RunSummary[][] = [];
  for (const run of runs.filter((r) => !used.has(r.runId))) {
    const last = groups.at(-1)?.at(-1);
    const lastEnd = last ? Date.parse(last.endedAt ?? last.startedAt) : -Infinity;
    if (last && Date.parse(run.startedAt) - lastEnd <= LEGACY_GAP_MS) groups.at(-1)!.push(run);
    else groups.push([run]);
  }
  for (const group of groups) {
    const agents = group.map(agentOf);
    const failed = group.find((r) => r.state !== 'ok' && r.state !== 'running');
    const fnState = (fn: string) => (group.some((r) => runApp(r)?.fn === fn && r.state === 'ok') ? 'explorada' as const : 'fallo' as const);
    const lastRun = group.at(-1)!;
    corridas.push({
      id: `legacy-${group[0].runId}`, trigger: { kind: 'desconocido' }, startedAt: group[0].startedAt,
      ...(lastRun.state !== 'running' ? { endedAt: lastRun.endedAt ?? lastRun.startedAt } : {}),
      state: group.some((r) => r.state === 'running') ? 'running' : failed ? 'error' : 'ok',
      ...(failed?.error ? { error: failed.error.split('\n')[0].slice(0, 300) } : {}),
      functions: [...new Set(agents.flatMap((a) => (a.fn ? [a.fn] : [])))].map((id) => ({ id, status: fnState(id) })),
      costUsd: cost(agents),
      agents,
      legacy: true,
    });
  }
  return corridas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function corridasOf(entry: RepoEntry, app: string, runs: RunSummary[]): Promise<Corrida[]> {
  const records = await listRunRecords(entry.productRepo, app);
  const busy = await withActiveRepo(entry, () => exploreWorkerBusy()).catch(() => false);
  return buildCorridas(records, appRuns(runs, entry.productRepo, app), busy);
}

// ---------- Inventario (#155, 2/4)
// The app's functions as ronin found them (inventory.yml, §11.6): at the
// open exploration PR's branch, which each run updates, or at the base once
// there's no PR.

export interface InventarioFn {
  id: string;
  nombre: string;
  rutas: string[];
  prioridad: string;
  notas?: string;
  retirada?: string;
  // charter → the last date it was explored with, in any viewport.
  charters: Record<string, string>;
  viewports: string[];
  ultima?: string;
  hallazgos: number;
}

export interface Inventario {
  from: { branch: string; pr?: number };
  actualizado?: { fecha: string; sha: string };
  charters: readonly string[];
  funciones: InventarioFn[];
  error?: string;
}

export function inventarioFrom(raw: string): Pick<Inventario, 'actualizado' | 'funciones'> {
  const inventory = parseInventory(raw);
  return {
    ...(inventory.actualizado ? { actualizado: inventory.actualizado } : {}),
    funciones: inventory.funciones.map((f) => {
      const charters: Record<string, string> = {};
      const viewports: string[] = [];
      for (const vp of VIEWPORTS) {
        const done = f.cobertura?.[vp] ?? {};
        if (Object.keys(done).length) viewports.push(vp);
        for (const [charter, date] of Object.entries(done)) if (date && (!charters[charter] || date > charters[charter])) charters[charter] = date;
      }
      const dates = Object.values(charters).sort();
      return {
        id: f.id, nombre: f.nombre, rutas: f.rutas, prioridad: f.prioridad,
        ...(f.notas ? { notas: f.notas } : {}), ...(f.retirada ? { retirada: f.retirada } : {}),
        charters, viewports, ...(dates.length ? { ultima: dates.at(-1) } : {}), hallazgos: f.hallazgos.length,
      };
    }),
  };
}

export async function inventarioOf(entry: RepoEntry, app: string, pr: Pick<ExplorationPr, 'number' | 'headRefName'> | undefined): Promise<Inventario> {
  const branch = pr ? pr.headRefName : (entry.worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
  const from = { branch, ...(pr ? { pr: pr.number } : {}) };
  const raw = await readBranchFile(entry, branch, `${EXPLORATION_DIR}/${app}/inventory.yml`);
  if (raw === null) return { from, charters: CHARTERS, funciones: [], error: `no hay inventory.yml de ${app} en ${branch}` };
  try {
    return { from, charters: CHARTERS, ...inventarioFrom(raw) };
  } catch (error) {
    return { from, charters: CHARTERS, funciones: [], error: `no se pudo leer inventory.yml: ${(error as Error).message.split('\n')[0]}` };
  }
}

// ---------- Explorar ahora (#155, 3/4)
// A run started from the dashboard: ronin still chooses the functions and
// the charters (§11.1, §11.4) — only how many and for how long are asked.
// By default it stands for that night's run of the app, since the weekly
// Claude limit is the one the day's work uses too.

// Each repo's open PRs, from its GitHub read (items/github.ts), by repo.
export const prsOf = <P>(entries: Array<{ productRepo: string }>, github: Array<{ prs: P[] } | null | undefined>) => new Map(entries.map((entry, i) => [entry.productRepo, github[i]?.prs ?? []]));

export class ExploreNowError extends DomainError {}

export interface ExploreNow {
  maxFunctions: number;
  // The time cap, in hours; null for none.
  hours: number | null;
  // Whether it stands for the app's next nightly run.
  tonight: boolean;
}

export const EXPLORE_NOW_MAX_FUNCTIONS = 10;
export const EXPLORE_NOW_HOURS = [1, 2, 4];

export function parseExploreNow(body: Record<string, unknown>): ExploreNow {
  const n = body.maxFunctions ?? config.exploreFunctionsPerNight;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > EXPLORE_NOW_MAX_FUNCTIONS) throw new ExploreNowError(`la cantidad de funciones va de 1 a ${EXPLORE_NOW_MAX_FUNCTIONS}`);
  const hours = body.hours ?? null;
  if (hours !== null && !EXPLORE_NOW_HOURS.includes(hours as number)) throw new ExploreNowError(`el tope de tiempo es de ${EXPLORE_NOW_HOURS.join(', ')} horas, o ninguno`);
  if (body.tonight !== undefined && typeof body.tonight !== 'boolean') throw new ExploreNowError('"tonight" es sí o no');
  return { maxFunctions: n, hours: hours as number | null, tonight: body.tonight !== false };
}

// A launch just made, by repo: its worker takes a moment to take the lock,
// and a second click meanwhile would start another (that would only find
// the lock taken, but say it was started).
const launchedAt = new Map<string, number>();
const LAUNCH_GRACE_MS = 60_000;

export interface ExploreNowDeps {
  busy: () => Promise<boolean>;
  launch: (request: ExploreWorkerRequest) => void;
  markNight: (night: string) => Promise<void>;
}

export async function exploreNow(entry: RepoEntry, app: string, login: string, ask: ExploreNow, now = new Date(), deps?: Partial<ExploreNowDeps>): Promise<{ until?: string; night?: string }> {
  const repo = entry.productRepo;
  const busy = deps?.busy ?? (() => withActiveRepo(entry, () => exploreWorkerBusy()));
  const launch = deps?.launch ?? launchExploreWorker;
  const markNight = deps?.markNight ?? ((night: string) => withActiveRepo(entry, () => setNightlyExploration(app, night)));
  if (now.getTime() - (launchedAt.get(repo) ?? 0) < LAUNCH_GRACE_MS || (await busy())) {
    throw new ExploreNowError(`ya hay una exploración corriendo en ${repo}: una por repo a la vez`, { status: 409 });
  }
  let night: string | undefined;
  if (ask.tonight) {
    night = upcomingNight(now, parseNightWindow(config.exploreNightWindow), config.exploreTimezone);
    await markNight(night);
  }
  const until = ask.hours ? new Date(now.getTime() + ask.hours * 3600_000).toISOString() : undefined;
  launchedAt.set(repo, now.getTime());
  launch({ repo, appName: app, maxFunctions: ask.maxFunctions, by: login, ...(until ? { until } : {}) });
  return { ...(until ? { until } : {}), ...(night ? { night } : {}) };
}

export function resetExploreNow(): void {
  launchedAt.clear();
}
