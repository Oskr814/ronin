import { useSyncExternalStore } from 'react';
import { useHost, type ExplorationRow, type ExplorationsView } from '../../host.js';
import { when } from '../../lib/format.js';

// What the Exploraciones pages share (#155): the apps as the shell has them,
// and how an app's state is written, as app.js writes it for the item's head.

const MIN = 60e3;
// The list read again this often while its page is open (app.js), and an
// app's runs and inventory: the runs often (one may be going), the
// inventory seldom (it changes once per run).
export const RUNS_EVERY_MS = 10_000;
export const INVENTORY_EVERY_MS = 60_000;
// A launched app says "arrancando…" this long, until the snapshot sees its worker.
const STARTING_MS = 3 * MIN;

export type Row = ExplorationRow;

// The apps, again whenever the snapshot or the list change.
export function useExplorations(): ExplorationsView {
  const host = useHost();
  return useSyncExternalStore(host.subscribe, host.explorations);
}

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
