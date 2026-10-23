import { useQueryClient } from '@tanstack/react-query';
import { client, ok } from '@apps/dashboard/src/api.js';
import { useRepoColor, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { onCommit, Row, Sec, SectionLink, Source, Switch, useChange } from './parts.js';
import { repoShort, type Repos } from './model.js';
import type { Data } from './Settings.js';

// Ajustes → Repos (#174, stage 5): what of repos.json can change from here,
// written into the file. Adding a repo, its paths and its Claude account
// stay in the file.

export function RepoList({ data }: { data: Data }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const d = data.repos;
  if (!d) return <><h1>Repos</h1><div className="empty">Cargando…</div></>;
  const open = (repo: string) => shell.openSettings('repos', repo);
  return <>
    <h1>Repos</h1><p className="lead">Los repos que supervisa ronin. Todo sigue en <code>repos.json</code>: lo que se cambia aquí se escribe ahí, con las mismas reglas que lo leen y una copia del anterior. Agregar o quitar un repo, su checkout y su cuenta de Claude se hacen en el archivo.</p>
    <div className="aj-card"><table className="aj-tbl"><thead><tr><th>Repo</th><th className="hide-m">Portal</th><th className="hide-m">Linear</th><th className="hide-m">Despliegues</th><th className="hide-m">Exploración</th></tr></thead><tbody>
      {d.repos.map((r) => {
        const explored = r.apps.filter((a) => a.explore).map((a) => a.id).join(', ');
        return (
          <tr key={r.repo} data-ajrepo-row={r.repo} tabIndex={0} onClick={() => open(r.repo)} onKeyDown={(event) => { if (event.key === 'Enter') open(r.repo); }}>
            <td><b><i className="aj-sq" style={{ background: repoColor(r.repo) }} />{r.repo}</b><small className="mono">{r.baseRef ?? d.defaults.baseRef}</small></td>
            <td className="hide-m">{r.portal ? <>{r.portal.name}<small>{r.apps.filter((a) => a.portal).length} apps</small></> : <span className="m">—</span>}</td>
            <td className="hide-m">{r.linear ? (r.linear.connected ? <span className="ok-t">● conectado</span> : <span className="warn-t">○ sin key en .env</span>) : <span className="m">—</span>}</td>
            <td className="hide-m">{r.deploy ? `${r.deploy.prerelease ? 'QA y producción' : 'release'}${r.deploy.auto ? ', automático' : ''}` : <span className="m">—</span>}</td>
            <td className="hide-m">{explored || <span className="m">—</span>}</td>
          </tr>
        );
      })}
    </tbody></table></div><p className="aj-foot">Archivo: <code>{d.path}</code></p>
  </>;
}

const options = (values: string[]) => values.map((v) => <option key={v} value={v}>{v}</option>);

export function Repo({ data, repo }: { data: Data; repo: string }) {
  const shell = useShell();
  const queryClient = useQueryClient();
  const change = useChange();
  const d = data.repos;
  const crumbs = <div className="aj-crumbs"><SectionLink to="repos">Repos</SectionLink> › <span>{repo}</span></div>;
  const r = d?.repos.find((x) => x.repo === repo);
  if (!d) return <>{crumbs}<div className="empty">Cargando…</div></>;
  if (!r) return <>{crumbs}<p className="bad">Ese repo no está en repos.json.</p></>;
  const [owner, name] = repo.split('/');
  const save = (body: Record<string, unknown>) => change(async () => {
    const { changed } = (await ok(client.api.settings.repos[':owner'][':name'].$post({ param: { owner, name }, json: body }))) as { changed: boolean };
    queryClient.setQueryData(['settings', 'repos'], (await ok(client.api.settings.repos.$get())) as unknown as Repos);
    shell.toast(changed ? 'Guardado en repos.json.' : 'Sin cambios.');
  });
  // A field of the repo: empty is none, but the portal's name stays as typed.
  const field = (key: string) => onCommit<HTMLInputElement | HTMLSelectElement>((el) => save({ [key]: el.value.trim() || (key === 'portalName' ? el.value : null) }));
  const fixed = (label: string, value: string, key: string) => <Row label={label} ctl={<span className="aj-ro">{value}</span>} src={<Source name={key} file="repos.json" />} />;
  const projects = r.linear?.projects ?? [];
  const deploy = (key: 'on' | 'prerelease' | 'selective', on: boolean) => {
    if (key === 'on' && !on && !confirm(`¿Dejar de desplegar ${repo} desde el tablero?`)) return;
    save({ deploy: { [key]: on } });
  };
  return <>
    {crumbs}<h1>{repoShort(r.repo)}</h1><p className="lead">{r.repo}</p>
    <Sec title="General">
      {r.portal ? <Row label="Nombre en el portal" desc="Con el que lo ve quien pide." ctl={<input className="aj-in" maxLength={80} data-ajr="portalName" defaultValue={r.portal.name} aria-label="Nombre en el portal" ref={field('portalName')} />} /> : null}
      <Row label="Rama base" desc="De donde sale cada rama de ronin. Vacío: la de .env." ctl={<input className="aj-in mono" data-ajr="baseRef" defaultValue={r.baseRef ?? ''} placeholder={d.defaults.baseRef} aria-label="Rama base" ref={field('baseRef')} />} />
      {fixed('Checkout', r.productRepoPath, 'productRepoPath')}
      {r.claudeConfigDir ? fixed('Cuenta de Claude', r.claudeConfigDir, 'claudeConfigDir') : null}
      {r.changelogRepo ? fixed('Changelog', r.changelogRepo, 'changelogRepo') : null}
    </Sec>
    <section className="aj-sec"><h2>Apps</h2><p className="aj-d">Las de <code>ronin.app.json</code> del repo, una por tarjeta.</p>
      {r.apps.length ? r.apps.map((a) => {
        const lastInPortal = a.portal && r.apps.filter((x) => x.portal).length === 1;
        const toggle = (key: 'portal' | 'explore', on: boolean) => save({ app: { id: a.id, [key]: !on } });
        const text = (key: 'name' | 'description' | 'project') => onCommit<HTMLInputElement | HTMLSelectElement>((el) => save({ app: { id: a.id, [key]: el.value || (key === 'project' ? null : el.value) } }));
        return (
          <div key={a.id} className="aj-card aj-appcard"><div className="aj-apphead"><b className="mono">{a.id}</b>{a.inManifest ? null : <small className="warn-t">ya no está en ronin.app.json</small>}</div>
            <Row label="En el portal" desc={lastInPortal ? 'Es la única app del portal en este repo: el portal necesita al menos una.' : 'Quien pide ajustes puede elegirla.'} ctl={<Switch on={a.portal} data-ajapp={a.id} data-f="portal" label={`${a.id} en el portal`} disabled={lastInPortal || (!a.inManifest && !a.portal)} onToggle={() => toggle('portal', a.portal)} />} />
            {a.portal ? <>
              <Row label="Nombre en el portal" desc="Con el que la ve quien pide." ctl={<input className="aj-in" maxLength={80} data-ajapp={a.id} data-f="name" defaultValue={a.name ?? ''} aria-label={`Nombre de ${a.id} en el portal`} ref={text('name')} />} />
              <Row label="Descripción" desc="Una línea debajo del nombre, para saber cuál elegir." ctl={<input className="aj-in aj-wide" maxLength={200} data-ajapp={a.id} data-f="description" defaultValue={a.description ?? ''} placeholder="Opcional" aria-label={`Descripción de ${a.id}`} ref={text('description')} />} />
            </> : null}
            <Row label="Exploración nocturna" desc="ronin la usa de noche y propone mejoras en el PR de exploración." ctl={<Switch on={a.explore} data-ajapp={a.id} data-f="explore" label={`Explorar ${a.id} de noche`} onToggle={() => toggle('explore', a.explore)} />} />
            {r.linear ? <Row label="Proyecto de Linear" desc="Donde van los issues que abre su exploración." ctl={<select className="aj-in" data-ajapp={a.id} data-f="project" aria-label={`Proyecto de Linear de ${a.id}`} defaultValue={a.project ?? ''} ref={text('project')}><option value="">Sin proyecto</option>{options([...new Set([...(a.project ? [a.project] : []), ...projects])])}</select>} /> : null}
          </div>
        );
      }) : <div className="aj-card"><div className="aj-row"><span className="m">No se pudo leer ronin.app.json del repo.</span></div></div>}
    </section>
    {r.portal?.notifyTo.length ? (
      <Sec title="Correos de repos.json" lead={<>Lo que <code>portal.notifyTo</code> manda todavía a quien no eligió en Notificaciones. Cuando cada uno tenga su correo en el perfil, se puede quitar.</>}>
        {r.portal.notifyTo.map((mail) => <Row key={mail} label={mail} ctl={<button className="btn-s" data-ajnotify={mail} onClick={() => {
          if (!confirm(`¿Quitar ${mail} de portal.notifyTo? Si es de alguien del equipo, recibe lo que elija en Notificaciones.`)) return;
          save({ notifyTo: r.portal!.notifyTo.filter((m) => m !== mail) });
        }}>Quitar</button>} />)}
      </Sec>
    ) : null}
    <Sec title="Linear">
      <Row label="API key" desc="El nombre de la variable de .env que la tiene. La key nunca pasa por el tablero." ctl={<select className="aj-in mono" data-ajr="linear" aria-label="API key de Linear" defaultValue={r.linear?.apiKeyEnv ?? ''} ref={field('linear')}><option value="">Sin Linear</option>{options([...new Set([...(r.linear ? [r.linear.apiKeyEnv] : []), ...d.linearKeys])])}</select>}
        src={r.linear ? (r.linear.connected ? <span className="ok-t">● Conectado</span> : <span className="warn-t">○ Esa variable no está en .env</span>) : <span>Solo se listan las variables LINEAR_API_KEY_* que hay en .env.</span>} />
    </Sec>
    <Sec title="Ejecución">
      <Row label="Tareas en paralelo" desc={`Los agentes de este repo que corren a la vez; el resto espera en su cola, que no comparte con los otros repos. Vacío: el general (${d.defaults.concurrency}, en Agentes).`} ctl={<><input className="aj-num" type="number" min="1" step="1" max={d.maxConcurrency} data-ajconc defaultValue={r.concurrency ?? ''} placeholder={String(d.defaults.concurrency)} aria-label="Tareas en paralelo" ref={onCommit((el) => save({ concurrency: el.value.trim() ? Number(el.value) : null }))} /><span className="aj-unit">a la vez</span></>} />
    </Sec>
    <Sec title="Merge">
      <Row label="Auto-merge en los PRs de ronin" desc="Los PRs que ronin abre para un issue salen con ronin:auto-merge y se mergean apenas un dev los aprueba y CI está en verde. Sacarle el label a uno lo deja para mergear a mano. Apagado: solo los que alguien marque con /auto-merge." ctl={<Switch on={r.autoMerge} data-ajautomerge="" label="Auto-merge en los PRs de ronin" onToggle={() => save({ autoMerge: !r.autoMerge })} />} />
    </Sec>
    <Sec title="Despliegues">
      <Row label="Desplegar desde el tablero" desc="Un release de GitHub con el tag escrito a mano." ctl={<Switch on={Boolean(r.deploy)} data-ajdeploy="on" label="Despliegues" onToggle={() => deploy('on', !r.deploy)} />} />
      {r.deploy ? <>
        <Row label="Pre-release primero" desc="QA antes de producción." ctl={<Switch on={r.deploy.prerelease} data-ajdeploy="prerelease" label="Pre-release" onToggle={() => deploy('prerelease', !r.deploy!.prerelease)} />} />
        <Row label="Solo los PRs que se elijan" desc="En vez de todo lo mergeado desde el último release." ctl={<Switch on={r.deploy.selective} data-ajdeploy="selective" label="PRs elegidos" onToggle={() => deploy('selective', !r.deploy!.selective)} />} />
        <Row label="Despliegue automático de los pedidos" desc={<>Cada tick, los PRs de pedidos del portal mergeados salen solos en un release, sobre el último. El patrón del tag: <code>{'{major}'}</code>, <code>{'{minor}'}</code> y <code>{'{patch}'}</code> del último release (con <code>+1</code>), <code>{'{yyyy}'}</code>, <code>{'{mm}'}</code>, <code>{'{dd}'}</code> y <code>{'{n}'}</code>, el lote del día. Vacío: apagado.{r.deploy.selective ? '' : ' Necesita «Solo los PRs que se elijan».'}</>}
          ctl={<input className="aj-in mono" data-ajdeploy="auto" defaultValue={r.deploy.auto ?? ''} placeholder="v{major}.{minor}.{patch+1}" disabled={!r.deploy.selective && !r.deploy.auto} aria-label="Patrón del tag del despliegue automático" ref={onCommit((el) => save({ deploy: { auto: el.value.trim() || null } }))} />} />
      </> : null}
    </Sec>
    <Sec title="Agentes en este repo" lead="Gana sobre lo general para todo lo que corre en este repo.">
      <Row label="Modelo" desc="Para una cuenta de Claude con límites más bajos." ctl={<select className="aj-in" data-ajagent="model" aria-label="Modelo" defaultValue={d.models.includes(r.agent.model) ? r.agent.model : ''} ref={onCommit((el) => save({ agent: { model: el.value || null } }))}><option value="">El general ({d.defaults.model})</option>{options(d.models)}</select>} />
      <Row label="Esfuerzo" ctl={<select className="aj-in" data-ajagent="effort" aria-label="Esfuerzo" defaultValue={d.efforts.includes(r.agent.effort) ? r.agent.effort : ''} ref={onCommit((el) => save({ agent: { effort: el.value || null } }))}><option value="">El general ({d.defaults.effort})</option>{options(d.efforts)}</select>} />
    </Sec>
  </>;
}
