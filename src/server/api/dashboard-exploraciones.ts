import { config } from '../../core/config.js';
import { getNightlyExploration } from '../../core/local-state.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { addDays, instantAt, wallClock } from '../../core/timezone.js';
import { currentNight, parseNightWindow, type NightWindow } from '../../exploration/schedule.js';
import type { RunSummary } from './dashboard-data.js';
import { explorationReview, isExplorationPr, type ExplorationPr, type Ficha } from './dashboard-exploration.js';

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

// Every exploration run's label starts with `app <name>`, and the one on a
// function goes on with ` → <function id>` (exploration/prompts.ts).
const LABEL_RE = /^app ([\w.-]+)(?: → (.+))?$/;
export const isExplorationRun = (run: Pick<RunSummary, 'taskType'>) => run.taskType.startsWith('explore-');

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

// The snapshot's rows: cheap, from what the snapshot already read.
export function exploracionRows(entries: RepoEntry[], prsByRepo: Map<string, PrLike[]>, runs: RunSummary[]): ExploracionRow[] {
  return entries.flatMap((entry) => {
    const repo = entry.productRepo;
    const open = (prsByRepo.get(repo) ?? []).find(isExplorationPr);
    const pr = open ? { number: open.number, id: `${repo}#${open.number}`, title: open.title, ...(open.url ? { url: open.url } : {}) } : null;
    return (entry.explore ?? []).map((app) => {
      const live = appRuns(runs, repo, app).filter((run) => run.state === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      const fn = live && runApp(live)?.fn;
      return { repo, app, pr, running: live ? { since: live.startedAt, ...(live.lastStep ? { step: live.lastStep } : {}), ...(fn ? { fn } : {}) } : null };
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
      // The same reading as dashboard-exploration-actions.ts's waitingOnRonin.
      const last = f.comments[f.comments.length - 1];
      const waiting = last && last.author.toLowerCase() !== ronin.toLowerCase() && (!last.replyTo || mention.test(last.body));
      if (waiting) counts.esperando++;
      else counts.decidir++;
    }
  }
  return counts;
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
