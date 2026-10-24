import type { ReactNode } from 'react';
import { type ExplorationRow, type ExplorationsView, useExplorations, useRepoColor, useSession, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { hhmm, when } from '@apps/dashboard/src/lib/format.js';
import { RUN_STATE } from '@apps/dashboard/src/lib/runs.js';
import { ago } from '@ui/time.js';

// What the Exploraciones pages share (#155): the apps as the shell has them,
// and how an app's state and head are written, on its page and its PR's.

const MIN = 60e3;
// The list read again this often while its page is open (the shell), and an
// app's runs and inventory: the runs often (one may be going), the
// inventory seldom (it changes once per run).
export const RUNS_EVERY_MS = 10_000;
export const INVENTORY_EVERY_MS = 60_000;
// A launched app says "arrancando…" this long, until the snapshot sees its worker.
const STARTING_MS = 3 * MIN;

export type Row = ExplorationRow;

// The apps, again whenever the snapshot or the list change.
export { useExplorations };

export const rowOf = (view: ExplorationsView, repo: string, app: string) => view.rows.find((r) => r.repo === repo && r.app === app) ?? null;
export const listRowOf = (view: ExplorationsView, r: Row) => view.list?.find((x) => x.repo === r.repo && x.app === r.app) ?? null;

// The params of an app's routes (/api/explorations/<owner>/<repo>/<app>/…).
export const at = (repo: string, app: string) => {
  const [owner, name] = repo.split('/');
  return { param: { owner, name, app } };
};

export const starting = (view: ExplorationsView, r: Row) => !r.running && view.launched[r.repo]?.app === r.app && Date.now() - view.launched[r.repo].at < STARTING_MS;

// Why it can't start now, or null: one run per repo at a time.
export function blocked(view: ExplorationsView, r: Row): string | null {
  const other = view.rows.find((x) => x.repo === r.repo && x.running);
  if (other) return other.app === r.app ? `ronin ya está explorando ${r.app}` : `ronin está explorando ${other.app}, del mismo repo: una por repo a la vez`;
  return Date.now() - (view.launched[r.repo]?.at ?? 0) < STARTING_MS ? 'la exploración que pediste está arrancando' : null;
}

// The nightly run: right now while the window is open and the app didn't start yet.
export const nextRun = (iso: string | null | undefined) => (!iso ? '' : Date.parse(iso) <= Date.now() + MIN ? 'esta noche, en cuanto haya lugar' : when(iso));

export function Chip({ view, r }: { view: ExplorationsView; r: Row }) {
  if (r.running) return <span className="chip run">explorando{r.running.fn ? ` ${r.running.fn}` : ''}</span>;
  if (starting(view, r)) return <span className="chip run">arrancando…</span>;
  if (!r.pr) return <span className="chip idle">sin PR de exploración</span>;
  const c = listRowOf(view, r)?.fichas;
  if (!c) return <span className="chip idle">PR abierto</span>;
  if (c.decidir) return <span className="chip warn">{c.decidir} {c.decidir === 1 ? 'ficha' : 'fichas'} por decidir</span>;
  if (c.esperando) return <span className="chip run">esperando a ronin</span>;
  return <span className="chip ok">nada por decidir</span>;
}

// An app's head: its page's, and its exploration PR's (pages/item), whose
// page it is, with the PR's buttons and its state on GitHub.
export function XplHead({ r, buttons, pill }: { r: Row; buttons?: ReactNode; pill?: ReactNode }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const session = useSession();
  const view = useExplorations();
  const l = listRowOf(view, r);
  const facts: string[] = [];
  if (r.running) facts.push(`desde las ${hhmm(r.running.since)}`);
  else if (l?.lastRun) facts.push(`última corrida ${ago(l.lastRun.at)}${l.lastRun.state === 'ok' ? '' : `, ${RUN_STATE[l.lastRun.state]?.[2] ?? l.lastRun.state}`}`);
  if (l?.nightly === false) facts.push('sin exploración nocturna');
  else if (l?.next) facts.push(`próxima: ${nextRun(l.next)}`);
  const why = blocked(view, r);
  return (
    <div className="head">
      <div className="crumb"><button className="crumb-l" onClick={() => shell.openExplorations()}>Exploraciones</button><span>/</span><i style={{ background: repoColor(r.repo) }} />{r.repo}</div>
      <div className="row"><h1>{r.app}</h1>{buttons}{session.can(r.repo, 'acciones') && <button className="act-btn" disabled={Boolean(why)} title={why ?? undefined} onClick={() => shell.exploreNow(r.repo, r.app)}>Explorar ahora</button>}</div>
      <div className="state">{pill}<Chip view={view} r={r} />{facts.map((f) => <span key={f}>{f}</span>)}</div>
    </div>
  );
}
