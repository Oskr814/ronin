import { useHost } from '../../host.js';
import { hhmm } from '../../lib/format.js';
import { RUN_STATE } from '../../lib/runs.js';
import { useViewState } from '../../lib/view-state.js';
import { ago } from '../../../../../ui/time.js';
import { ExplorationInventory } from './Inventory.js';
import { blocked, Chip, listRowOf, nextRun, rowOf, useExplorations, type Row } from './model.js';
import { ExplorationRuns } from './Runs.js';

// An app a repo explores, with no exploration PR open (#155): its runs and
// its inventory until ronin opens one. Then the app's page is its PR's
// (app.js goes there on its own), headed as the app's.

type Tab = 'corridas' | 'inventario';

function Head({ r }: { r: Row }) {
  const host = useHost();
  const view = useExplorations();
  const l = listRowOf(view, r);
  const facts: string[] = [];
  if (r.running) facts.push(`desde las ${hhmm(r.running.since)}`);
  else if (l?.lastRun) facts.push(`última corrida ${ago(l.lastRun.at)}${l.lastRun.state === 'ok' ? '' : `, ${RUN_STATE[l.lastRun.state]?.[2] ?? l.lastRun.state}`}`);
  if (l?.next) facts.push(`próxima: ${nextRun(l.next)}`);
  const why = blocked(view, r);
  return (
    <div className="head">
      <div className="crumb"><button className="crumb-l" onClick={() => host.openExplorations()}>Exploraciones</button><span>/</span><i style={{ background: host.repoColor(r.repo) }} />{r.repo}</div>
      <div className="row"><h1>{r.app}</h1>{host.can(r.repo, 'acciones') && <button className="act-btn" disabled={Boolean(why)} title={why ?? undefined} onClick={() => host.exploreNow(r.repo, r.app)}>Explorar ahora</button>}</div>
      <div className="state"><Chip view={view} r={r} />{facts.map((f) => <span key={f}>{f}</span>)}</div>
    </div>
  );
}

export function Exploration({ repo, app }: { repo: string; app: string }) {
  const view = useExplorations();
  const [tab, setTab] = useViewState<Tab>('exploration-tab', 'corridas');
  const r = rowOf(view, repo, app);
  if (!r) return <div className="today pd"><p className="bad">Ningún repo de ronin explora la app {app}.</p></div>;
  return <>
    <Head r={r} />
    <div className="doctabs" role="tablist">{([['corridas', 'Corridas'], ['inventario', 'Inventario']] as const).map(([k, label]) => (
      <button key={k} className="doctab" role="tab" aria-selected={k === tab} onClick={() => setTab(k)}>{label}</button>
    ))}</div>
    <div className="doc" id="doc">
      <div className="xpl-doc">
        <div className="pd-card xpl-empty"><h3>Sin PR de exploración</h3>
          <p>Se abre con la primera ficha que ronin proponga para {r.app}, y las corridas siguientes se suman al mismo PR hasta que lo apruebes.{r.running ? ' La corrida de ahora puede abrirlo.' : ''}</p></div>
        {tab === 'inventario' ? <ExplorationInventory repo={r.repo} app={r.app} /> : <ExplorationRuns repo={r.repo} app={r.app} />}
      </div>
    </div>
  </>;
}
