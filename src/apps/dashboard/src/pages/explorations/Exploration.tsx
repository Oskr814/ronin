import { useViewState } from '../../lib/view-state.js';
import { ExplorationInventory } from './Inventory.js';
import { rowOf, useExplorations, XplHead } from './model.js';
import { ExplorationRuns } from './Runs.js';

// An app a repo explores, with no exploration PR open (#155): its runs and
// its inventory until ronin opens one. Then the app's page is its PR's
// (app.js goes there on its own), headed as the app's.

type Tab = 'corridas' | 'inventario';

export function Exploration({ repo, app }: { repo: string; app: string }) {
  const view = useExplorations();
  const [tab, setTab] = useViewState<Tab>('exploration-tab', 'corridas');
  const r = rowOf(view, repo, app);
  if (!r) return <div className="today pd"><p className="bad">Ningún repo de ronin explora la app {app}.</p></div>;
  return <>
    <XplHead r={r} />
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
