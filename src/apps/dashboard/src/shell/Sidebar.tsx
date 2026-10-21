import { Fragment, type ReactNode } from 'react';
import { GhIcon, LinearIcon } from '../lib/github.js';
import { clock, Dot, RunDot, runKind } from '../lib/runs.js';
import { short } from '../../../../ui/time.js';
import { Live } from './Live.js';
import {
  AJ_SECTIONS, canDo, changed, goHome, inScope, type Item, linearRepos, openSettings, openDeploys, openExploration, openExplorations, openMetrics,
  openNewIssue, openRequest, openRequests, openMeetings, projectColor, queryClient, repoColor, repoShort, S, safeRepo, saveScope, select,
  xplCounts, xplRows, xplToDecide,
} from './state.js';
import type { ExplorationRow } from './hooks.js';

// The sidebar: where to go (Hoy, what runs, the queue, the pages), Linear's
// filter, and the work, repo by repo. Ajustes has its own.

const SLICE_STATE: Record<string, [string, string]> = { merged: ['ok', 'mergeada'], open: ['warn', 'abierta'], pending: ['pending', 'pendiente'], closed: ['crit', 'PR cerrado sin mergear'] };
export const cycleName = (c: { name?: string; number: number }) => c.name || `Ciclo ${c.number}`;

type Slice = NonNullable<Item['slices']>[number];
// A slice: its PR's icon, or the pending dot while it has none.
export const SliceMark = ({ slice }: { slice: Slice }) => (slice.status === 'pending' ? <Dot cls={SLICE_STATE.pending[0]} /> : <GhIcon kind="pr" state={slice.status === 'open' ? (slice.draft ? 'draft' : 'open') : slice.status} />);

export function itemRef(item: Item) {
  if (item.kind === 'issue') return `#${item.number}`;
  if (item.kind === 'pr') return `PR #${item.number}`;
  return item.lastRun ? runKind(item.lastRun) : '';
}

function itemAge(item: Item) {
  const run = item.lastRun;
  if (item.status === 'running' && run) return clock(Date.now() - Date.parse(run.startedAt));
  if (item.status === 'blocked' && item.block) return short(Date.now() - Date.parse(item.block.at));
  return run ? short(Date.now() - Date.parse(run.endedAt ?? run.startedAt)) : '';
}
function itemLast(item: Item) {
  if (item.status === 'running') return item.lastRun?.lastStep ?? '';
  if (item.status === 'blocked') return item.block?.reason ?? 'bloqueado';
  if (item.note) return item.note;
  return item.lastRun?.lastStep ?? '';
}

// An issue with an open PR shows it with GitHub's PR icon (open or draft)
// right after its own number.
function itemSub(item: Item): ReactNode[] {
  const parts: ReactNode[] = [itemRef(item)];
  if (item.kind === 'issue' && item.pr) parts.push(<span className="ipr"><GhIcon kind="pr" state={item.pr.isDraft ? 'draft' : 'open'} />#{item.pr.number}{item.pr.author && item.pr.author !== 'ronin-agent' ? ` de ${item.pr.author}` : ''}</span>);
  if (item.slices?.length) parts.push(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} ${item.slices.length === 1 ? 'slice' : 'slices'}`);
  else if (item.kind === 'pr' && item.pr?.author && item.pr.author !== 'ronin-agent') parts.push(`de ${item.pr.author}`);
  else if (item.kind !== 'other' && !item.pr && item.lastRun) parts.push(runKind(item.lastRun));
  return parts.filter(Boolean).flatMap((part, i) => (i ? [', ', <Fragment key={i}>{part}</Fragment>] : [<Fragment key={i}>{part}</Fragment>]));
}

const EXPLORE_ICON = <svg className="pin-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="m15 9-2 4-4 2 2-4z" /></svg>;

// An item's preview, on its sidebar row: ready to open, or still on its way
// (its data being prepared, or moving to a new commit).
function PreviewTag({ preview }: { preview: Item['preview'] }) {
  if (!preview) return null;
  const ready = !preview.preparing && !preview.updating;
  const title = ready ? `Preview de #${preview.prNumber} lista` : preview.preparing ? `Preview de #${preview.prNumber}: preparando los datos` : `Preview de #${preview.prNumber}: actualizándose`;
  return <span className={`pvtag ${ready ? 'ok' : 'prep'}`} title={title}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>{ready ? 'preview' : 'preview…'}</span>;
}

// `hit`: the PR number the search found the issue by, whose slice shows highlighted.
function ItemRow({ item, hit }: { item: Item; hit: number | null }) {
  const last = itemLast(item);
  const showSlices = item.slices?.length && (S.sel === item.id || item.status === 'running' || item.status === 'blocked' || hit);
  return (
    <>
      <button className={`item ${item.pinned ? 'pinned' : ''}`} data-id={item.id} aria-current={S.sel === item.id} title={item.pinned ? 'PR de exploración: sus fichas se revisan acá' : undefined} onClick={() => void select(item.id)}>
        {item.pinned ? EXPLORE_ICON : <RunDot state={item.status} />}<span className="t">{item.title}</span><Live className="age" since={item.status === 'running' && item.lastRun ? item.lastRun.startedAt : undefined} text={itemAge(item)} />
        <span className="sub"><PreviewTag preview={item.preview} /><GhIcon kind={item.kind} state={item.github} />{itemSub(item)}{item.linear && <>, <span className="red">{item.linear.id}</span></>}{item.linear?.project && !S.project && <>, <span className="ptag"><i style={{ background: projectColor(item.linear.project.id) }} />{item.linear.project.name}</span></>}</span>
        {last ? <span className="last">{last}</span> : null}
      </button>
      {showSlices ? <div className="kids">{item.slices!.map((slice) => <button key={slice.index} className={`kid ${hit && slice.prNumber === hit ? 'hit' : ''}`} data-id={item.id} onClick={() => void select(item.id)}><SliceMark slice={slice} /><span className="t">{slice.index + 1}. {slice.title}</span><span className="age">{slice.prNumber ? `#${slice.prNumber}` : ''}</span></button>)}</div> : null}
    </>
  );
}

type Pedido = NonNullable<NonNullable<typeof S.snap>['pedidos']>[number];
const PED_CLOSED = ['done', 'resolved', 'declined', 'cancelled'];
const firstName = (name: string | null | undefined) => String(name ?? '').split(' ')[0];

// Who a request waits on, in the sidebar's row.
function waitsLabel(p: Pedido) {
  const who = firstName(p.person);
  switch (p.waitsOn) {
    case 'person': return p.status === 'proposed' ? `${who}: aprobar o ajustar` : p.status === 'interviewing' ? `${who}: responder las preguntas` : p.status === 'confirming' ? `${who}: confirmar el resumen` : `${who}: responder`;
    case 'ronin': return p.running ? 'ronin trabajando' : p.status === 'approved' && p.issue ? `ronin: el cambio en #${p.issue}` : p.status === 'fixing' && p.issue ? `ronin: el arreglo en #${p.issue}` : p.status === 'minor' ? 'ronin: el prototipo' : p.status === 'reproducing' ? 'ronin: reproducirlo' : p.status === 'thinking' ? 'ronin: leerlo' : 'ronin: abrir el issue';
    case 'team': return p.pr ? `Un dev: aprobar el PR #${p.pr}` : `El equipo: #${p.issue}`;
    default: return PED_CLOSED.includes(p.status) ? 'Cerrado' : 'Nadie';
  }
}

function PedRow({ p }: { p: Pedido }) {
  const tone = p.running ? 'live' : p.waitsOn === 'person' || p.waitsOn === 'team' ? 'warn' : p.waitsOn === 'ronin' ? 'run' : 'idle';
  return (
    <button className="item" data-ped={p.number} aria-current={S.page === 'pedido' && S.ped.n === p.number} onClick={() => openRequest(Number(p.number))}><Dot cls={tone} /><span className="t"><span className="pd-pn">P-{p.number}</span> {p.title}</span><span className="age">{short(Date.now() - Date.parse(p.lastAt))}</span>
      <span className="sub">{waitsLabel(p)}</span></button>
  );
}

// An app a repo explores (#155): exploring it now, findings to decide on, or nothing pending.
function XplRow({ r }: { r: ExplorationRow }) {
  const c = xplCounts(r);
  const tone = r.running ? 'live' : c?.decidir ? 'warn' : c?.esperando ? 'run' : 'idle';
  const sub = r.running ? `explorando${r.running.fn ? ` ${r.running.fn}` : ''}` : !r.pr ? 'sin PR de exploración' : c ? (c.decidir ? `${c.decidir} ${c.decidir === 1 ? 'ficha' : 'fichas'} por decidir` : c.esperando ? 'esperando a ronin' : 'nada por decidir') : `PR #${r.pr.number}`;
  return (
    <button className="item" data-xpl={`${r.repo}|${r.app}`} aria-current={S.page === 'exploracion' && S.xpl.repo === r.repo && S.xpl.app === r.app} onClick={() => openExploration(r.repo, r.app)}><Dot cls={tone} /><span className="t">{r.app}</span><span className="age">{r.pr ? `#${r.pr.number}` : ''}</span>
      <span className="sub">{repoShort(r.repo)}, {sub}</span></button>
  );
}

// The sidebar's "en curso", from what Despliegues last read.
const depGoing = () => (queryClient.getQueryData<Array<{ releases?: Array<{ deploy?: { state: string } }> }>>(['deploys']) ?? []).some((r) => (r.releases ?? []).some((x) => x.deploy?.state === 'running'));

function Quick() {
  const snap = S.snap!;
  if (S.page === 'ajustes') return <AjNav />;
  const running = snap.items.filter((item) => item.status === 'running').length;
  const queued = snap.runner.queue.length;
  const filter = (f: 'running' | 'queue') => () => {
    S.filter = S.filter === f ? null : f;
    changed();
  };
  return (
    <div className="quick" id="quick">
      <button data-home aria-pressed={!S.sel && !S.page} onClick={goHome}><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>Hoy</button>
      <button data-filter="running" aria-pressed={S.filter === 'running'} onClick={filter('running')}><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>Corriendo ahora<span className="c">{running}</span></button>
      <button data-filter="queue" aria-pressed={S.filter === 'queue'} onClick={filter('queue')}><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" /></svg>En cola<span className="c">{queued}</span></button>
      {snap.portalAdmin || snap.pedidosTotal ? <button data-portal aria-pressed={['pedidos', 'pedido'].includes(S.page ?? '') && !S.sel} onClick={() => openRequests()}><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3" /></svg>Pedidos del portal<span className="c">{snap.pedidos?.length || ''}</span></button> : null}
      {snap.repos.length ? <button data-reuniones aria-pressed={['reuniones', 'reunion'].includes(S.page ?? '') && !S.sel} onClick={() => openMeetings()}><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></svg>Reuniones<span className="c">{snap.reunionesPorRevisar || ''}</span></button> : null}
      {snap.despliegues ? <button data-dep-page aria-pressed={S.page === 'despliegues' && !S.sel} onClick={() => openDeploys()}><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></svg>Despliegues<span className="c">{depGoing() ? 'en curso' : ''}</span></button> : null}
      {xplRows().length ? <button data-xpl-page aria-pressed={['exploraciones', 'exploracion'].includes(S.page ?? '')} onClick={() => openExplorations()}><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5M14 8l-2 4-4 2 2-4z" /></svg>Exploraciones<span className="c">{xplToDecide() || ''}</span></button> : null}
      {snap.access?.admin ? <button data-mt-page aria-pressed={S.page === 'metricas' && !S.sel} onClick={() => openMetrics()}><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3" /></svg>Métricas</button> : null}
    </div>
  );
}

// Ajustes' own: Tu cuenta, and Administración for admins.
function AjNav() {
  const snap = S.snap!;
  const button = (sec: string) => <button data-aj={sec} aria-pressed={S.aj.sec === sec && !(sec === 'repos' && S.aj.repo)} onClick={() => openSettings(sec, null)}><svg viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: AJ_SECTIONS[sec].icon }} />{AJ_SECTIONS[sec].name}</button>;
  return (
    <div className="quick" id="quick">
      <button data-aj-back onClick={goHome}><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>Volver al tablero</button>
      <div className="aj-grp">Tu cuenta <span>{snap.me}</span></div>{button('perfil')}{button('notificaciones')}
      {snap.access.admin ? <><div className="aj-grp">Administración</div>{button('general')}{button('usuarios')}{button('repos')}{snap.repos.map((repo) => <button key={repo} className="aj-sub" data-aj="repos" data-ajrepo={repo} aria-pressed={S.aj.sec === 'repos' && S.aj.repo === repo} onClick={() => openSettings('repos', repo)}><i style={{ background: repoColor(repo) }} />{repoShort(repo)}</button>)}{button('agentes')}{button('cuentas')}{button('exploracion')}{button('previews')}{button('conexiones')}{button('registro')}</> : null}
    </div>
  );
}

// Linear's filter: the current cycle or everything, and a project. Only for
// repos with a Linear key; the cycle is the first one's.
function Scope() {
  const linear = linearRepos();
  if (S.page === 'ajustes' || !linear.length) return <div className="scope" id="scope" hidden />;
  const snap = S.snap!;
  const cycle = linear.find((l) => l.cycle)?.cycle;
  if (!cycle && S.scope === 'cycle') S.scope = 'all';
  const inCycle = snap.items.filter((item) => item.linear?.cycle?.current).length;
  const projects = new Map<string, string>();
  for (const item of snap.items) if (item.linear?.project) projects.set(item.linear.project.id, item.linear.project.name);
  if (S.project && !projects.has(S.project)) projects.set(S.project, 'Proyecto filtrado');
  const scope = (to: 'cycle' | 'all') => () => {
    S.scope = to;
    saveScope();
    changed();
  };
  return (
    <div className="scope" id="scope">
      <div className="lbl"><LinearIcon /> Linear{linear[0].workspace ? ` · ${linear[0].workspace}` : ''}{linear.some((l) => l.error) ? <> · <span className="bad">no se pudo leer</span></> : ''}</div>
      {cycle ? <div className="seg"><button data-scope="cycle" aria-pressed={S.scope === 'cycle'} onClick={scope('cycle')}>{cycleName(cycle)} · {inCycle}</button><button data-scope="all" aria-pressed={S.scope !== 'cycle'} onClick={scope('all')}>Todos</button></div> : null}
      <select id="proj" aria-label="Proyecto de Linear" value={S.project} onChange={(e) => {
        S.project = e.target.value;
        saveScope();
        changed();
      }}><option value="">Todos los proyectos</option>{[...projects].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    </div>
  );
}

function Tree() {
  const snap = S.snap!;
  if (S.page === 'ajustes') return <div className="tree" id="tree" />;
  if (S.filter === 'queue') {
    const queue = snap.runner.queue;
    return (
      <div className="tree" id="tree">
        <div className="grp"><span>Esperando un lugar para un agente</span><span className="n">{queue.length}</span></div>
        {queue.length
          ? queue.map((job, i) => <div key={i} className="queue-row"><span className="dot pending" aria-hidden="true" /><span>{job.label}{job.repo ? <> <span style={{ color: 'var(--muted)' }}>{repoShort(job.repo)}</span></> : ''}</span><Live className="age" since={job.since} text={clock(Date.now() - Date.parse(job.since))} /></div>)
          : <div className="grp-empty">Nada en cola: todo lo que hay para hacer ya tiene lugar.</div>}
      </div>
    );
  }
  const q = S.q.trim().toLowerCase();
  const num = /^#?(\d+)$/.exec(q)?.[1];
  // The PR number an issue was found by (one of its slices or its PRs).
  const prHit = (item: Item) => (num && item.number !== Number(num) && [...((item as { prs?: number[] }).prs ?? []), ...(item.slices ?? []).map((sl) => sl.prNumber)].includes(Number(num)) ? Number(num) : null);
  const matchQ = (item: Item) => `${item.title} ${itemRef(item)} ${item.number ?? ''} ${item.linear?.id ?? ''}`.toLowerCase().includes(q) || prHit(item) !== null;
  // Without searching, the listed ones (ronin's issues, the ones it worked
  // on that are still open, the exploration PR) and the one open on the
  // page; searching, or filtering by a Linear cycle or project, every open
  // issue (#100). A closed one shows only while open or searched. A PR
  // without an issue or a changelog entry shows only while it runs.
  const shown = (item: Item) => {
    if (S.filter === 'running') return item.status === 'running' && (!q || matchQ(item));
    if (item.kind !== 'issue') return false;
    if (q) return matchQ(item) && inScope(item);
    if (S.scope === 'cycle' || S.project) return item.kind === 'issue' && inScope(item);
    return item.listed || S.sel === item.id;
  };
  const row = (item: Item) => <ItemRow key={item.id} item={item} hit={prHit(item)} />;
  // Offered only when nothing has that number, as an issue or one of its PRs.
  const found = num && snap.items.some((item) => item.number === Number(num) || prHit(item) !== null);
  const blocked = snap.items.filter((item) => item.status === 'blocked' && shown(item));
  // The portal's requests still going (#132): not searched, and only the running ones while filtering by that.
  const pedidos = (snap.pedidos ?? []).filter((p) => !q && (S.filter !== 'running' || p.running));
  // The apps ronin explores (#155), whose exploration PR is no longer pinned in its repo: searched by the app or the PR's number.
  const xpls = xplRows().filter((r) => (S.filter !== 'running' || r.running) && (!q || r.app.toLowerCase().includes(q) || (num && r.pr?.number === Number(num))));
  return (
    <div className="tree" id="tree">
      {blocked.length ? <><div className="grp"><span>Necesitan a alguien</span><span className="n alert">{blocked.length}</span></div>{blocked.map(row)}</> : null}
      {pedidos.length ? <><div className="grp"><span>Pedidos en curso</span><span className="n">{pedidos.length}</span></div>{pedidos.map((p) => <PedRow key={p.number} p={p} />)}</> : null}
      {xpls.length ? <><div className="grp"><span>Exploraciones</span><span className="n">{xpls.length}</span></div>{xpls.map((r) => <XplRow key={`${r.repo}|${r.app}`} r={r} />)}</> : null}
      {snap.repos.map((repo) => {
        const items = snap.items.filter((item) => item.repo === repo && item.status !== 'blocked' && shown(item));
        return (
          <Fragment key={repo}>
            <div className="grp"><span className="sq" style={{ background: repoColor(repo) }} /><b>{repoShort(repo)}</b><span className="n">{items.length}</span>{canDo(repo, 'acciones') ? <button className="grp-add" data-new={repo} title={`Nuevo issue en ${repoShort(repo)}`} aria-label={`Nuevo issue en ${repoShort(repo)}`} onClick={() => openNewIssue(repo)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button> : null}</div>
            {items.length ? items.map(row) : <div className="grp-empty">{q || S.filter ? 'Nada coincide.' : S.scope === 'cycle' || S.project ? `Ningún issue abierto ${S.scope === 'cycle' ? 'en este ciclo' : ''}${S.project ? ' para este proyecto' : ''}.` : 'Nada en curso ni corridas en los últimos 3 días.'}</div>}
            {/* A number nothing listed has: open it anyway (a closed issue, a PR without an issue). */}
            {num && !found && safeRepo(repo) ? <button className="item open-n" data-id={`${repo}#${num}`} onClick={() => void select(`${repo}#${num}`)}><span className="dot pending" aria-hidden="true" /><span className="t">Abrir #{num}</span><span className="sub">{repoShort(repo)}, aunque esté cerrado o no tenga issue</span></button> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="side" aria-label="Trabajo de ronin">
      <div className="brand"><span className="seal" aria-hidden="true">浪人</span><b>ronin</b><button className="gear" id="gear" title="Ajustes" aria-label="Ajustes" onClick={() => openSettings()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg></button></div>
      <label className="search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input id="q" placeholder="Buscar un issue (título, número o PR)" aria-label="Buscar" value={S.q} onChange={(e) => {
        S.q = e.target.value;
        changed();
      }} /></label>
      <Quick />
      <Scope />
      <Tree />
    </aside>
  );
}
