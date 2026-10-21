import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { ago } from '@ui/time.js';
import { Chip, listRowOf, nextRun, useExplorations } from './model.js';

// Exploraciones (#155): one row per app a repo explores, from the snapshot;
// the list (/api/explorations, which the shell reads for the sidebar too) adds
// its exploration PR's findings counted, the last run and the next.

export function Explorations() {
  const shell = useShell();
  const view = useExplorations();
  return (
    <div className="today pd">
      <div className="reu-top"><div><h1>Exploraciones</h1><p className="lead">ronin usa cada app como lo haría un QA: encuentra dónde duele y propone cómo mejorarlo, con el antes y el después. Corre de noche, o con <code>/explore &lt;app&gt;</code> en un issue. Las fichas se revisan aquí, y ninguna abre su issue hasta que apruebes el PR.</p></div></div>
      {view.error && <p className="bad">{view.error}</p>}
      <table className="padm-t pd-t">
        <thead><tr><th>App</th><th>Estado</th><th className="hide-m">PR de exploración</th><th className="hide-m">Última corrida</th></tr></thead>
        <tbody>{view.rows.map((r) => {
          const l = listRowOf(view, r);
          const go = () => shell.openExploration(r.repo, r.app);
          return (
            <tr key={`${r.repo}|${r.app}`} tabIndex={0} onClick={go} onKeyDown={(event) => { if (event.key === 'Enter') go(); }}>
              <td><span className="tt">{r.app}</span><small>{r.repo}</small></td>
              <td><Chip view={view} r={r} />{r.running?.step && <small>{r.running.step}</small>}</td>
              <td className="hide-m">{r.pr ? <><span className="pd-gh">#{r.pr.number}</span>{l?.fichas && <small>{l.fichas.total} {l.fichas.total === 1 ? 'ficha' : 'fichas'}</small>}</> : <small>se abre con la primera ficha</small>}</td>
              <td className="hide-m m">{l?.lastRun ? ago(l.lastRun.at) : '—'}{l?.next && <small>próxima: {nextRun(l.next)}</small>}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
