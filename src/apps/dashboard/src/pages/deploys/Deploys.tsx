import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useHost } from '../../host.js';
import { ago, useNow } from '../../lib/time.js';
import { DeployDialog } from './DeployDialog.js';
import { subject, type Release, type Repo, type Repos } from './model.js';

// Despliegues (#158): a deploy is a GitHub release ronin publishes on the
// tag someone writes; the repo's workflow does the rest. Everything on the
// branch, or — where the repo allows it (deploy.selective) — only the PRs
// picked, cherry-picked onto the last release.


const EVERY_MS = 30_000;
// While a deploy's workflow goes.
const GOING_EVERY_MS = 10_000;
const STATE: Record<string, [string, string]> = { running: ['live', 'en curso'], deployed: ['ok', 'desplegado'], failed: ['crit', 'falló'], unknown: ['idle', 'sin workflow'] };

const going = (repos: Repos | undefined) => (repos ?? []).some((r) => 'releases' in r && r.releases.some((x) => x.deploy?.state === 'running'));
export function Deploys() {
  const host = useHost();
  const [dialog, setDialog] = useState<{ repo: string; pr?: number } | null>(null);
  const query = useQuery({
    queryKey: ['deploys'],
    queryFn: () => ok(client.api.deploys.$get()).then((d) => d.repos),
    // Not while the dialog is open: it plans on its own.
    refetchInterval: (q) => (dialog ? false : going(q.state.data) ? GOING_EVERY_MS : EVERY_MS),
  });
  const repos = query.data;
  useEffect(() => {
    if (repos) host.read?.('deploys', repos);
  }, [repos, host]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) host.unauthorized(query.error.message);
  }, [query.error, host]);

  const head = (
    <>
      <h1>Despliegues</h1>
      <p className="lead">Un despliegue es un release de GitHub: ronin lo publica con el tag que escribas y el workflow del repo hace el resto. Lleva todo lo mergeado o, donde el repo lo permite, solo los PRs que elijas. Cuando el workflow termina bien, los pedidos del portal que entraron le avisan a su persona.</p>
    </>
  );
  const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? <p className="bad">{query.error.message}</p> : null;
  return (
    <div className="today pd">
      {head}
      {error}
      {!repos ? (!error && <div className="empty">Cargando…</div>)
        : repos.length ? repos.map((r) => <Card key={r.repo} r={r} onNew={(pr) => setDialog({ repo: r.repo, pr })} />)
          : <p className="note">Ningún repo tiene <code>deploy</code> en repos.json.</p>}
      {dialog && repos && <DeployDialog repos={repos} repo={dialog.repo} pr={dialog.pr} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Card({ r, onNew }: { r: Repo; onNew: (pr?: number) => void }) {
  const host = useHost();
  const now = useNow();
  const header = <i style={{ background: host.repoColor(r.repo) }} />;
  if (!('pending' in r)) {
    return <section className="pd-card dep-card"><header>{header}<b>{r.repo}</b></header><p className="bad">No se pudo leer: {r.error}</p></section>;
  }
  const p = r.pending;
  return (
    <section className="pd-card dep-card">
      <header>
        {header}<b>{r.repo}</b>
        <span className="m">desde {r.branch}{r.prerelease ? ' · con pre-releases' : ''}{r.selective ? ' · PRs elegidos' : ''}</span>
        <button className="act-btn" onClick={() => onNew()}>Nuevo despliegue</button>
      </header>
      <div className="dep-pend">
        {!p.base ? <p className="m">El repo no tiene releases todavía: el primero lleva todo lo de la rama.</p>
          : p.changes.length ? (
            <>
              <div className="dep-h"><b>{p.changes.length === 1 ? '1 cambio' : `${p.changes.length} cambios`}</b> mergeados desde <span className="pd-gh">{p.base}</span>, sin desplegar</div>
              <ul className="dep-list">
                {p.changes.map((c) => (
                  <li key={c.sha}>
                    <span className="pd-gh">{c.pr ? `#${c.pr}` : c.sha.slice(0, 7)}</span><span className="t">{subject(c)}</span>
                    {c.apps.length > 0 && <span className="apps">{c.apps.join(' · ')}</span>}
                    {c.pedidos.map((n) => <button key={n} className="chip plain goped" onClick={() => host.openPedido(n)}>del pedido P-{n}</button>)}
                    {r.selective && c.pr && <button className="link" onClick={() => onNew(c.pr!)}>Desplegar solo este</button>}
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="m">Nada mergeado desde {p.base}.</p>}
      </div>
      {r.releases.length > 0 && (
        <table className="padm-t dep-t">
          <thead><tr><th>Release</th><th className="hide-m">Publicado</th><th>Workflow</th><th className="hide-m">Por</th></tr></thead>
          <tbody>{r.releases.map((x) => <ReleaseRow key={x.tag} x={x} now={now} />)}</tbody>
        </table>
      )}
    </section>
  );
}

function ReleaseRow({ x, now }: { x: Release; now: number }) {
  const d = x.deploy;
  const [cls, label] = d ? STATE[d.state] ?? STATE.unknown : [];
  return (
    <tr>
      <td>
        <span className="dep-tag">{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.tag}</a> : x.tag}</span>
        {x.latest && <span className="chip ok">Latest</span>}{x.prerelease && <span className="chip warn">Pre-release</span>}{d?.mode === 'pick' && <span className="chip run">Solo elegidos</span>}
      </td>
      <td className="hide-m m">{ago(x.at, now)}</td>
      <td>
        {d ? (
          <>
            <span className="dep-wf">
              <span className={`dot ${cls}`} aria-hidden="true" />{label}
              {d.runs.length > 0 && <> · {d.runs.map((run, i) => <span key={run.url}>{i > 0 && ', '}<a href={run.url} target="_blank" rel="noopener">{run.name}</a></span>)}</>}
            </span>
            {d.releaseError && <small className="bad">El release no se creó: {d.releaseError}</small>}
            {d.pedidos.length > 0 && <small>{d.pedidos.map((n) => `P-${n}`).join(', ')}</small>}
          </>
        ) : <span className="m">publicado en GitHub</span>}
      </td>
      <td className="hide-m m">{d?.by ?? ''}</td>
    </tr>
  );
}
