import { Fragment, type ReactNode } from 'react';
import { LinearIcon } from '../lib/github.js';
import { dayMonth } from '../lib/format.js';
import { clock, Dot, duration, money, RunDot, runTitle } from '../lib/runs.js';
import { short } from '@ui/time.js';
import { Live } from './Live.js';
import { cycleName, SliceMark } from './Sidebar.js';
import { currentCycleOf, detailOf, type Item, itemById, itemRuns, linearRepos, MINUTE, repoColor, repoShort, S, safeRepo } from './state.js';

// The context column: what's around the item open (GitHub, Linear, why it's
// blocked, its slices, checks, preview and runs), or, with none, the
// runner, the previews and what was read of GitHub and Linear. On a phone,
// under the item's page.

const SLICE_STATE: Record<string, [string, string]> = { merged: ['ok', 'mergeada'], open: ['warn', 'abierta'], pending: ['pending', 'pendiente'], closed: ['crit', 'PR cerrado sin mergear'] };
const CHECK_STATE: Record<string, [string, string]> = { passed: ['ok', 'pasó'], pending: ['live', 'corriendo'], failed: ['crit', 'falló'] };
// A cycle ends at midnight: its last day is the one before.
export const endDay = (iso: string) => dayMonth(new Date(Date.parse(iso) - 1).toISOString());
const safeLinear = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://linear.app/');
const prUrl = (repo: string, number: number) => (safeRepo(repo) ? `https://github.com/${repo}/pull/${number}` : null);
function githubUrl(item: Item & { url?: string }) {
  if (item.url && item.url.startsWith('https://github.com/')) return item.url;
  if (item.number === undefined || !safeRepo(item.repo)) return null;
  return `https://github.com/${item.repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
}

function GithubCtx({ item }: { item: Item }) {
  const url = githubUrl(item);
  if (!url) return null;
  return <section><h3>GitHub</h3><dl className="kv"><dt>{item.kind === 'pr' ? 'PR' : 'Issue'}</dt><dd><a href={url} target="_blank" rel="noopener">#{item.number} ↗</a></dd></dl></section>;
}

// Without the synced issue, only the reference ronin left on GitHub.
function LinearCtx({ item }: { item: Item }) {
  const l = item.linear;
  const ref = (detailOf(item.id) as { linear?: { id: string; url?: string } } | undefined)?.linear;
  if (!l) return ref ? <section><h3><LinearIcon /> Linear</h3><dl className="kv"><dt>Issue</dt><dd>{safeLinear(ref.url) ? <a href={ref.url} target="_blank" rel="noopener">{ref.id} ↗</a> : ref.id}</dd></dl></section> : null;
  const current = l.cycle?.current ? currentCycleOf(item.repo) : null;
  return (
    <section><h3><LinearIcon /> Linear</h3><dl className="kv">
      <dt>Issue</dt><dd>{safeLinear(l.url) ? <a href={l.url} target="_blank" rel="noopener">{l.id} ↗</a> : l.id}</dd>
      <dt>Estado</dt><dd>{l.state.name}</dd>
      <dt>Proyecto</dt><dd>{l.project ? l.project.name : '—'}</dd>
      <dt>Ciclo</dt><dd>{l.cycle ? `${cycleName(l.cycle)}${current ? `, termina el ${endDay(current.endsAt)}` : ''}` : '—'}</dd>
      {l.assignee ? <><dt>Asignado</dt><dd>{l.assignee}</dd></> : null}</dl>
      {l.cycle?.current && item.kind === 'issue' ? <p className="note">Es del ciclo actual: si no alcanzan los lugares para agentes, ronin lo toma antes que los demás.</p> : null}</section>
  );
}

// While its test data is being prepared, the preview is up but not ready to
// try: the URL is shown as such, not as a link to open yet. While it moves
// to a new commit of the PR it still answers, on the commit it had.
function Preview({ preview }: { preview: NonNullable<Item['preview']> }) {
  const left = preview.expiresAt ? Date.parse(preview.expiresAt) - Date.now() : null;
  const safe = /^https?:\/\//.test(preview.url);
  const host = preview.url.replace(/^https?:\/\//, '');
  return (
    <section><h3>Preview</h3><div className="pv">{preview.appName} con #{preview.prNumber}{preview.sha ? <> en <span className="mono">{preview.sha.slice(0, 7)}</span></> : null}</div>
      {preview.updating ? <div className="pv-prep"><Dot cls="live" /><span>Actualizándose con el commit nuevo del PR.</span></div> : null}
      {preview.preparing
        ? <><div className="pv-prep"><Dot cls="live" /><span>Preparando los datos para probar el PR. La URL queda lista cuando termine.</span></div>{safe ? <span className="url off">{host}</span> : null}</>
        : safe ? <a className="url" href={preview.url} target="_blank" rel="noopener">{host}</a> : null}
      {left !== null ? <><dl className="kv" style={{ marginTop: '8px' }}><dt>Se baja en</dt><Live as="dd" until={preview.expiresAt!} text={clock(left)} /></dl><div className="ttl"><span style={{ width: `${Math.max(0, Math.min(100, (left / (60 * MINUTE)) * 100))}%` }} /></div></> : null}
      <p className="note">Los usuarios de prueba están en el comentario de la preview, en el PR.</p></section>
  );
}

export function ItemCtx({ item }: { item: Item }) {
  const runs = itemRuns(item);
  const shown = runs.length ? runs[Math.min(S.runIdx[item.id] ?? 0, runs.length - 1)] : null;
  const cost = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const failed = runs.filter((run) => ['error', 'timeout', 'cut'].includes(run.state)).length;
  const merged = item.slices?.filter((s) => s.status === 'merged').length ?? 0;
  return (
    <>
      <GithubCtx item={item} />
      <LinearCtx item={item} />
      {item.status === 'blocked' ? (
        <section><h3>Por qué está bloqueado</h3><div className="why">{item.block
          ? <><b>Hace {short(Date.now() - Date.parse(item.block.at))}.</b> {item.block.reason}{item.block.excerpt ? <span className="ask">{item.block.excerpt}</span> : null}</>
          : 'ronin no guardó el motivo en este runner (puede ser de antes del tablero): está en el email del bloqueo.'}
          {' '}<span className="ask">Cuando esté resuelto, volvé a ponerle <code>ronin:in-progress</code> al issue.</span></div></section>
      ) : null}
      {item.slices?.length ? (
        <section className="orch"><h3>Slices</h3><div className="parent"><RunDot state={item.status} /><span>#{item.number}</span><small>{merged} de {item.slices.length} {item.slices.length === 1 ? 'mergeada' : 'mergeadas'}</small></div>
          <div className="kidsx">{item.slices.map((slice) => {
            const [, text] = SLICE_STATE[slice.status];
            const link = slice.prNumber ? prUrl(item.repo, slice.prNumber) : null;
            const detail = slice.status === 'open' ? [slice.checks && slice.checks !== 'none' ? `checks: ${CHECK_STATE[slice.checks][1]}` : null, slice.reviewDecision === 'APPROVED' ? 'aprobada' : slice.reviewDecision === 'CHANGES_REQUESTED' ? 'cambios pedidos' : null].filter(Boolean).join(', ') : '';
            return <div key={slice.index} className={`sl ${slice.status === 'pending' ? 'pending' : ''}`}><SliceMark slice={slice} /><span>{slice.index + 1}. {slice.title}</span>{link ? <a href={link} target="_blank" rel="noopener">#{slice.prNumber}</a> : <span />}<small>{text}{detail ? `, ${detail}` : ''}</small></div>;
          })}</div></section>
      ) : null}
      {item.pr?.checks?.length ? <section><h3>Checks de #{item.pr.number}</h3><ul className="checks">{item.pr.checks.map((check, i) => <li key={i}><Dot cls={CHECK_STATE[check.outcome][0]} /><span>{check.name}</span><span className="m">{CHECK_STATE[check.outcome][1]}</span></li>)}</ul></section> : null}
      {item.preview ? <Preview preview={item.preview} /> : null}
      {shown ? (
        <>
          <section><h3>Esta corrida</h3><dl className="kv">
            <dt>Tarea</dt><dd>{runTitle(shown)}{shown.sliceIndex !== undefined ? `, slice ${shown.sliceIndex + 1}` : ''}</dd>
            {shown.model ? <><dt>Modelo</dt><dd>{shown.model}{shown.effort ? `, ${shown.effort}` : ''}</dd></> : null}
            <dt>Cuenta</dt><dd>{shown.account}</dd>
            <dt>Empezó</dt><dd>{new Date(shown.startedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}</dd>
            {shown.durationMs !== undefined ? <><dt>Duró</dt><dd>{duration(shown.durationMs)}</dd></> : null}
            {shown.costUsd !== undefined ? <><dt>Costo</dt><dd>{money(shown.costUsd)}</dd></> : null}
            <dt>Worktree</dt><dd className="mono" style={{ fontSize: '12px' }}>{shown.worktree}</dd></dl></section>
          <section><h3>Últimos 14 días</h3><dl className="kv"><dt>Corridas</dt><dd>{runs.length}{failed ? `, ${failed} con error` : ''}</dd>{cost ? <><dt>Costo</dt><dd>{money(cost)}</dd></> : null}</dl></section>
        </>
      ) : null}
    </>
  );
}

// What this session sees and why (#106): everything as an admin, or the
// repos GitHub says it can at least triage.
const PERMISSION: Record<string, string> = { triage: 'triage', push: 'escritura', maintain: 'maintain', admin: 'admin' };
function Access() {
  const access = S.snap!.access;
  if (!access) return null;
  if (access.admin) return <section><h3>Tu acceso</h3><p className="note" style={{ margin: 0 }}>Sos administrador del tablero: ves todos los repos.</p></section>;
  return (
    <section><h3>Tu acceso</h3><dl className="kv">{access.repos.map((r) => <Fragment key={r.repo}><dt><span className="repo-tag"><i style={{ background: repoColor(r.repo) }} />{repoShort(r.repo)}</span></dt><dd>{PERMISSION[r.permission] ?? r.permission} en GitHub</dd></Fragment>)}</dl>
      <p className="note">Ves los repos en los que podés gestionar issues (triage o más) en GitHub. Se vuelve a consultar cada 10 minutos: si te dan o te sacan acceso, el tablero lo sigue.</p></section>
  );
}

const lines = (parts: ReactNode[]) => parts.flatMap((part, i) => (i ? [<br key={`b${i}`} />, part] : [part]));

function Runner() {
  const snap = S.snap!;
  const { tick, slots } = snap.runner;
  const repos = (slots.repos ?? []).map((r) => `${repoShort(r.repo)}: ${r.used} de ${r.limit}`);
  return (
    <>
      <Access />
      <section><h3>Runner</h3><dl className="kv">
        <dt>Agentes</dt><dd>{repos.length ? lines(repos) : `${slots.used} de ${slots.limit} lugares ocupados`}</dd>
        <dt>Último tick</dt><dd>{tick.lastTickAt ? `hace ${short(Date.now() - Date.parse(tick.lastTickAt))}, duró ${duration(tick.lastTickDurationMs ?? 0)}` : 'sin datos hoy'}</dd>
        <dt>Último evento</dt><dd>{tick.lastEventAt ? `hace ${short(Date.now() - Date.parse(tick.lastEventAt))}` : 'sin datos hoy'}</dd>
        <dt>Repos</dt><dd>{lines(snap.repos.map((repo) => <span key={repo} className="repo-tag"><i style={{ background: repoColor(repo) }} />{repo}</span>))}</dd></dl></section>
      <section><h3>Previews arriba</h3>{snap.previews.length ? snap.previews.map((p, i) => <div key={i} className="pv-row"><div>{p.appName} con #{p.prNumber} <span className="m">{repoShort(p.repo)}{p.updating ? ', actualizando' : p.preparing ? ', preparando datos' : ''}</span></div>{/^https?:\/\//.test(p.url) ? (p.preparing ? <span className="url off">{p.url.replace(/^https?:\/\//, '')}</span> : <a className="url" href={p.url} target="_blank" rel="noopener">{p.url.replace(/^https?:\/\//, '')}</a>) : null}</div>) : <p className="note">Ninguna.</p>}</section>
      {linearRepos().map((l) => (
        <section key={l.repo}><h3><LinearIcon /> Linear · {repoShort(l.repo)}</h3><dl className="kv">
          {l.workspace ? <><dt>Workspace</dt><dd>{l.workspace}{l.cycle ? ` (equipo ${l.cycle.team})` : ''}</dd></> : null}
          <dt>Ciclo actual</dt><dd>{l.cycle ? `${cycleName(l.cycle)}, ${dayMonth(l.cycle.startsAt)} – ${endDay(l.cycle.endsAt)}` : 'ninguno'}</dd>
          <dt>Leído</dt><dd>{l.error ? <span className="bad">no se pudo leer: {l.error}</span> : l.fetchedAt ? `hace ${short(Date.now() - Date.parse(l.fetchedAt))}` : 'sin leer'}</dd></dl></section>
      ))}
      <section><h3>GitHub</h3><dl className="kv">{snap.github.map((g) => <Fragment key={g.repo}><dt>{repoShort(g.repo)}</dt><dd>{g.error ? <><span className="bad">no se pudo leer: {g.error}</span>{g.fetchedAt ? `, datos de hace ${short(Date.now() - Date.parse(g.fetchedAt))}` : ''}</> : g.fetchedAt ? `leído hace ${short(Date.now() - Date.parse(g.fetchedAt))}` : 'sin leer'}</dd></Fragment>)}</dl></section>
    </>
  );
}

export function Context() {
  const item = itemById(S.sel);
  return <aside className="ctx" id="ctx" aria-label="Contexto">{item ? <ItemCtx item={item} /> : <Runner />}</aside>;
}
