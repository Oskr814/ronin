// The dashboard (#65): a page with no data of its own — everything comes from
// the API (/api/*), behind the GitHub login. Plain JS, no build: the two
// libraries it needs are copied into vendor/ (the CSP only runs our own scripts).

import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.esm.js';
import { OCTICON } from './vendor/octicons.js';

const MIN = 60e3;
const SNAPSHOT_EVERY_MS = 5000;
// A portal request's page (#132), read again this often while it's open.
const PEDIDO_EVERY_MS = 10_000;

const TYPE = {
  'plan': 'Planificar', 'implement-slice': 'Implementar slice', 'fix-issue': 'Corregir slice', 'fix-review': 'Responder review',
  'fix-e2e': 'Arreglar e2e', 'review-request': 'Pedido en review', 'fix-comments': 'Aplicar comentarios',
  'fix-comments-external': 'Aplicar comentarios', 'resolve-conflicts': 'Resolver conflictos', 'thread-reply-external': 'Responder hilo',
  'external-review': 'Review externa', 'spike': 'Spike', 'write-spec': 'Escribir spec', 'issue-request': 'Pedido en issue',
  'prototype': 'Prototipo', 'update-changelog': 'Changelog', 'explore-inventory': 'Inventario de exploración',
  'explore-function': 'Explorar', 'explore-evaluate': 'Evaluar exploración', 'explore-redo-after': 'Rehacer captura',
  'explore-feedback': 'Comentarios de exploración', 'commit-subject': 'Mensaje de commit', 'prepare-preview-data': 'Datos de preview', 'portal-request': 'Pedido del portal', 'portal-prototype': 'Prototipo del portal', 'portal-reproduce': 'Reproducción del portal', 'meeting-read': 'Lectura de reunión',
};
const VERB = { Bash: 'Corrió', Read: 'Leyó', Edit: 'Editó', MultiEdit: 'Editó', Write: 'Escribió', NotebookEdit: 'Editó', Grep: 'Buscó', Glob: 'Buscó', WebFetch: 'Abrió', WebSearch: 'Buscó en la web', Task: 'Lanzó un agente', Agent: 'Lanzó un agente', TodoWrite: 'Anotó tareas' };
const STATE = {
  running: ['live', 'run', 'trabajando'],
  ok: ['ok', 'ok', 'terminó bien'],
  error: ['crit', 'crit', 'falló'],
  timeout: ['crit', 'crit', 'se pasó del tiempo'],
  usage_limit: ['warn', 'warn', 'sin cuota de Claude'],
  cut: ['crit', 'crit', 'se cortó'],
  blocked: ['crit', 'crit', 'bloqueado'],
  waiting: ['warn', 'warn', 'esperando a alguien'],
  open: ['pending', 'idle', 'abierto'],
};
const SLICE_STATE = { merged: ['ok', 'mergeada'], open: ['warn', 'abierta'], pending: ['pending', 'pendiente'], closed: ['crit', 'PR cerrado sin mergear'] };
// How an issue or PR stands on GitHub, with GitHub's own icon and color
// (#129): [class, short label, what it says in words, octicon]. The dot is
// what ronin does; this is what GitHub says.
const GH_STATE = {
  issue: {
    open: ['open', 'Abierto', 'Issue abierto', 'issue-opened'],
    completed: ['done', 'Cerrado', 'Issue cerrado como completado', 'issue-closed'],
    not_planned: ['neutral', 'No planeado', 'Issue cerrado como no planeado', 'skip'],
  },
  pr: {
    open: ['open', 'Abierto', 'PR abierto', 'git-pull-request'],
    draft: ['neutral', 'Draft', 'PR en draft', 'git-pull-request-draft'],
    merged: ['done', 'Mergeado', 'PR mergeado', 'git-merge'],
    closed: ['closed', 'Cerrado', 'PR cerrado sin mergear', 'git-pull-request-closed'],
  },
};
const ghInfo = (kind, state) => (kind === 'issue' || kind === 'pr' ? GH_STATE[kind][state] : undefined);
const ghIcon = (kind, state) => {
  const info = ghInfo(kind, state);
  if (!info) return '';
  return `<svg class="ghi ${info[0]}" viewBox="0 0 16 16" role="img" aria-label="${info[2]}"><title>${info[2]}</title>${OCTICON[info[3]].map((d) => `<path d="${d}"/>`).join('')}</svg>`;
};
// An item's state: from the sidebar's read, else from its page (an old
// closed one opened with "Abrir #N").
function ghStateOf(item, d) {
  if (item.github) return item.github;
  const doc = item.kind === 'pr' ? d?.pr : item.kind === 'issue' ? d?.issue : undefined;
  if (!doc?.state) return undefined;
  if (doc.state === 'MERGED') return 'merged';
  if (doc.state === 'OPEN') return doc.isDraft ? 'draft' : 'open';
  if (item.kind === 'pr') return 'closed';
  return doc.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed';
}
// The item's state as GitHub's pill at the head of its page: "Abierto",
// "Cerrado", "Mergeado"…
function ghPill(item, d) {
  const state = ghStateOf(item, d);
  const info = ghInfo(item.kind, state);
  return info ? `<span class="ghs ${info[0]}" title="${info[2]}">${ghIcon(item.kind, state)}${info[1]}</span>` : '';
}
// A slice: its PR's icon, or the pending dot while it has none.
const sliceMark = (slice) => (slice.status === 'pending' ? dotClass(SLICE_STATE.pending[0]) : ghIcon('pr', slice.status === 'open' ? (slice.draft ? 'draft' : 'open') : slice.status));
const CHECK_STATE = { passed: ['ok', 'pasó'], pending: ['live', 'corriendo'], failed: ['crit', 'falló'] };

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeName = (type) => TYPE[type] ?? type;
const dot = (state) => `<span class="dot ${(STATE[state] ?? STATE.error)[0]}" aria-hidden="true"></span>`;
const dotClass = (cls) => `<span class="dot ${cls}" aria-hidden="true"></span>`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const isMobile = () => matchMedia('(max-width: 760px)').matches;

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
function short(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'recién';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
function duration(ms) {
  const m = Math.round(ms / MIN);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const money = (usd) => (usd < 0.01 ? 'menos de US$0,01' : `US$${usd.toFixed(2).replace('.', ',')}`);
const pct = (fraction) => `${Math.round(fraction * 100)}%`;

const S = { snap: null, today: null, sel: null, open: [], runIdx: {}, pendingRun: null, filter: null, q: '', itemRuns: {}, run: null, stream: null, detail: {}, view: {}, doc: {}, menu: false, dialog: null, expanded: new Set(), expl: {}, ficha: {}, fichaOpen: {}, fichaFilter: { tipo: 'todas', vp: 'todos' }, antes: {}, oldAfter: new Set(), lightbox: null, fmenu: false, fdialog: null, fdraft: {}, listas: {}, scope: 'all', project: '', attAll: false, extra: {}, newIssue: null, files: {}, fcur: {}, ffold: {}, fexp: {}, fcontent: {}, fq: {}, ftree: false, fcomp: null, fbusy: new Set(), rpanel: null, page: null, portal: { data: null, error: null }, pdialog: null, ped: { list: null, error: null, listAt: 0, detail: {}, n: null, tab: 'act', filter: 'todos', run: null, lb: null, patch: {} }, reu: { list: null, error: null, listAt: 0, detail: {}, n: null, tab: null, up: null, run: null, open: {}, retrying: false, form: {}, approving: false } };
// The sidebar's Linear filter (#101), remembered per browser.
try { Object.assign(S, JSON.parse(localStorage.getItem('ronin-scope') ?? '{}')); } catch { /* sin storage */ }
function saveScope() {
  try { localStorage.setItem('ronin-scope', JSON.stringify({ scope: S.scope, project: S.project })); } catch { /* sin storage */ }
}
const DETAIL_EVERY_MS = 30_000;
const WAITING_EVERY_MS = 10_000;

class Unauthorized extends Error {}

async function api(path, init) {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) {
    // The API's own explanation when it has one (an action it refused).
    const said = await response.json().then((body) => body?.error).catch(() => null);
    throw new Error(said ?? `${path}: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
}

// ---------- items
const repoIndex = (repo) => Math.max(0, (S.snap?.repos ?? []).indexOf(repo));
const repoColor = (repo) => `var(--repo-${repoIndex(repo) % 4})`;
const repoShort = (repo) => repo.split('/')[1] ?? repo;
// `extra`: what was opened by its number without being in the list (#100):
// a closed issue, a PR without an issue.
const itemById = (id) => S.snap?.items.find((item) => item.id === id) ?? S.extra[id];

// ---------- Linear (#101)
const LIN_ICON = '<svg width="12" height="12" viewBox="0 0 100 100" aria-hidden="true" style="vertical-align:-1px;flex:none"><path fill="currentColor" d="M1.2 61.5a50 50 0 0 0 37.3 37.3zM.1 48.9l51 51a50 50 0 0 0 9.3-1.4L1.5 39.6A50 50 0 0 0 .1 48.9zm3.6-17.8 65.2 65.2a50 50 0 0 0 7.2-3.9L7.6 23.9a50 50 0 0 0-3.9 7.2zm8.4-12.2a50 50 0 1 1 69 69z"/></svg>';
const cycleName = (c) => c.name || `Ciclo ${c.number}`;
const linearRepos = () => S.snap?.linear ?? [];
const currentCycleOf = (repo) => linearRepos().find((l) => l.repo === repo)?.cycle ?? null;
const dayMonth = (iso) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' }).replace('.', '');
const safeLinear = (url) => typeof url === 'string' && url.startsWith('https://linear.app/');
// A project's color follows the project, never its rank: the projects known
// to the page in name order, the first four with a color each, the rest gray.
function projectColor(id) {
  const names = new Map();
  for (const item of S.snap?.items ?? []) if (item.linear?.project) names.set(item.linear.project.id, item.linear.project.name);
  for (const c of S.today?.cycles ?? []) for (const i of c.issues) if (i.project) names.set(i.project.id, i.project.name);
  const order = [...names].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([pid]) => pid);
  const k = order.indexOf(id);
  return k >= 0 && k < 4 ? `var(--proj-${k})` : 'var(--proj-other)';
}
const inScope = (item) => (S.scope !== 'cycle' || item.linear?.cycle?.current) && (!S.project || item.linear?.project?.id === S.project);

function itemRef(item) {
  if (item.kind === 'issue') return `#${item.number}`;
  if (item.kind === 'pr') return `PR #${item.number}`;
  return item.lastRun ? typeName(item.lastRun.taskType) : '';
}
const safeRepo = (repo) => /^[\w.-]+\/[\w.-]+$/.test(repo);
function githubUrl(item) {
  if (item.url && item.url.startsWith('https://github.com/')) return item.url;
  if (item.number === undefined || !safeRepo(item.repo)) return null;
  return `https://github.com/${item.repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}`;
}
const prUrl = (repo, number) => (safeRepo(repo) ? `https://github.com/${repo}/pull/${number}` : null);
function itemAge(item) {
  const run = item.lastRun;
  if (item.status === 'running' && run) return clock(Date.now() - Date.parse(run.startedAt));
  if (item.status === 'blocked' && item.block) return short(Date.now() - Date.parse(item.block.at));
  return run ? short(Date.now() - Date.parse(run.endedAt ?? run.startedAt)) : '';
}
function itemLast(item) {
  if (item.status === 'running') return item.lastRun?.lastStep ?? '';
  if (item.status === 'blocked') return item.block?.reason ?? 'bloqueado';
  if (item.note) return item.note;
  return item.lastRun?.lastStep ?? '';
}

// ---------- sidebar
function renderQuick() {
  const running = S.snap.items.filter((item) => item.status === 'running').length;
  const queued = S.snap.runner.queue.length;
  $('#quick').innerHTML = `
    <button data-home aria-pressed="${!S.sel && !S.page}"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Hoy</button>
    <button data-filter="running" aria-pressed="${S.filter === 'running'}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>Corriendo ahora<span class="c">${running}</span></button>
    <button data-filter="queue" aria-pressed="${S.filter === 'queue'}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>En cola<span class="c">${queued}</span></button>
    ${S.snap.portalAdmin || S.snap.pedidosTotal ? `<button data-portal aria-pressed="${['pedidos', 'pedido', 'portal'].includes(S.page) && !S.sel}"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/></svg>Pedidos del portal<span class="c">${S.snap.pedidos?.length || ''}</span></button>` : ''}
    ${S.snap.repos.length ? `<button data-reuniones aria-pressed="${['reuniones', 'reunion'].includes(S.page) && !S.sel}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/></svg>Reuniones<span class="c">${S.snap.reunionesPorRevisar || ''}</span></button>` : ''}`;
  $('#quick').querySelector('[data-home]').onclick = goHome;
  $('#quick').querySelector('[data-portal]')?.addEventListener('click', () => openPedidos());
  $('#quick').querySelector('[data-reuniones]')?.addEventListener('click', () => openReuniones());
  renderScope();
  for (const button of $('#quick').querySelectorAll('[data-filter]')) {
    button.onclick = () => {
      S.filter = S.filter === button.dataset.filter ? null : button.dataset.filter;
      renderQuick();
      renderTree();
    };
  }
}

// Linear's filter: the current cycle or everything, and a project. Only for
// repos with a Linear key; the cycle is the first one's.
function renderScope() {
  const el = $('#scope');
  const linear = linearRepos();
  if (!linear.length) {
    el.hidden = true;
    return;
  }
  const cycle = linear.find((l) => l.cycle)?.cycle;
  if (!cycle && S.scope === 'cycle') S.scope = 'all';
  const inCycle = S.snap.items.filter((item) => item.linear?.cycle?.current).length;
  const projects = new Map();
  for (const item of S.snap.items) if (item.linear?.project) projects.set(item.linear.project.id, item.linear.project.name);
  if (S.project && !projects.has(S.project)) projects.set(S.project, 'Proyecto filtrado');
  el.hidden = false;
  el.innerHTML = `<div class="lbl">${LIN_ICON} Linear${linear[0].workspace ? ` · ${esc(linear[0].workspace)}` : ''}${linear.some((l) => l.error) ? ' · <span class="bad">no se pudo leer</span>' : ''}</div>
    ${cycle ? `<div class="seg"><button data-scope="cycle" aria-pressed="${S.scope === 'cycle'}">${esc(cycleName(cycle))} · ${inCycle}</button><button data-scope="all" aria-pressed="${S.scope !== 'cycle'}">Todos</button></div>` : ''}
    <select id="proj" aria-label="Proyecto de Linear"><option value="">Todos los proyectos</option>${[...projects].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([id, name]) => `<option value="${esc(id)}" ${S.project === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`;
  for (const button of el.querySelectorAll('[data-scope]')) {
    button.onclick = () => {
      S.scope = button.dataset.scope;
      saveScope();
      renderScope();
      renderTree();
    };
  }
  el.querySelector('#proj').onchange = (e) => {
    S.project = e.target.value;
    saveScope();
    renderTree();
  };
}

function itemSub(item) {
  const parts = [itemRef(item)];
  if (item.slices?.length) parts.push(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} ${item.slices.length === 1 ? 'slice' : 'slices'}`);
  else if (item.kind === 'pr' && item.pr?.author && item.pr.author !== 'ronin-agent') parts.push(`de ${item.pr.author}`);
  else if (item.kind === 'issue' && item.pr) parts.push(`PR #${item.pr.number}${item.pr.author && item.pr.author !== 'ronin-agent' ? ` de ${item.pr.author}` : ''}`);
  else if (item.kind !== 'other' && item.lastRun) parts.push(typeName(item.lastRun.taskType));
  return parts.filter(Boolean).join(', ');
}

const EXPLORE_ICON = '<svg class="pin-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m15 9-2 4-4 2 2-4z"/></svg>';

// `hit`: the PR number the search found the issue by, whose slice shows highlighted.
function itemRow(item, hit) {
  const last = itemLast(item);
  const showSlices = item.slices?.length && (S.sel === item.id || item.status === 'running' || item.status === 'blocked' || hit);
  const kids = showSlices ? `<div class="kids">${item.slices.map((slice) => `<button class="kid ${hit && slice.prNumber === hit ? 'hit' : ''}" data-id="${esc(item.id)}">${sliceMark(slice)}<span class="t">${slice.index + 1}. ${esc(slice.title)}</span><span class="age">${slice.prNumber ? `#${slice.prNumber}` : ''}</span></button>`).join('')}</div>` : '';
  return `<button class="item ${item.pinned ? 'pinned' : ''}" data-id="${esc(item.id)}" aria-current="${S.sel === item.id}" ${item.pinned ? 'title="PR de exploración: sus fichas se revisan acá"' : ''}>
    ${item.pinned ? EXPLORE_ICON : dot(item.status)}<span class="t">${esc(item.title)}</span><span class="age" ${item.status === 'running' && item.lastRun ? `data-since="${esc(item.lastRun.startedAt)}"` : ''}>${esc(itemAge(item))}</span>
    <span class="sub">${ghIcon(item.kind, item.github)}${esc(itemSub(item))}${item.linear ? `, <span class="red">${esc(item.linear.id)}</span>` : ''}${item.linear?.project && !S.project ? `, <span class="ptag"><i style="background:${projectColor(item.linear.project.id)}"></i>${esc(item.linear.project.name)}</span>` : ''}</span>
    ${last ? `<span class="last">${esc(last)}</span>` : ''}</button>${kids}`;
}

function pedRow(p) {
  const tone = p.running ? 'live' : p.waitsOn === 'person' || p.waitsOn === 'team' ? 'warn' : p.waitsOn === 'ronin' ? 'run' : 'idle';
  return `<button class="item" data-ped="${p.number}" aria-current="${S.page === 'pedido' && S.ped.n === p.number}">${dotClass(tone)}<span class="t"><span class="pd-pn">P-${p.number}</span> ${esc(p.title)}</span><span class="age">${esc(short(Date.now() - Date.parse(p.lastAt)))}</span>
    <span class="sub">${esc(waitsLabel(p))}</span></button>`;
}

function renderTree() {
  const tree = $('#tree');
  if (S.filter === 'queue') {
    const queue = S.snap.runner.queue;
    tree.innerHTML = `<div class="grp"><span>Esperando un lugar para un agente</span><span class="n">${queue.length}</span></div>` + (queue.length
      ? queue.map((job) => `<div class="queue-row"><span class="dot pending" aria-hidden="true"></span><span>${esc(job.label)}${job.repo ? ` <span style="color:var(--muted)">${esc(repoShort(job.repo))}</span>` : ''}</span><span class="age" data-since="${esc(job.since)}">${esc(clock(Date.now() - Date.parse(job.since)))}</span></div>`).join('')
      : `<div class="grp-empty">Nada en cola: todo lo que hay para hacer ya tiene lugar.</div>`);
    return;
  }
  const q = S.q.trim().toLowerCase();
  const num = /^#?(\d+)$/.exec(q)?.[1];
  // The PR number an issue was found by (one of its slices or its PRs).
  const prHit = (item) => (num && item.number !== Number(num) && [...(item.prs ?? []), ...(item.slices ?? []).map((sl) => sl.prNumber)].includes(Number(num)) ? Number(num) : null);
  const matchQ = (item) => `${item.title} ${itemRef(item)} ${item.number ?? ''} ${item.linear?.id ?? ''}`.toLowerCase().includes(q) || prHit(item) !== null;
  // Without searching, the listed ones (ronin's issues, the ones it worked
  // on that are still open, the exploration PR) and the one open on the
  // page; searching, or filtering by a Linear cycle or project, every open
  // issue (#100). A closed one shows only while open or searched. A PR
  // without an issue or a changelog entry shows only while it runs.
  const shown = (item) => {
    if (S.filter === 'running') return item.status === 'running' && (!q || matchQ(item));
    if (item.kind !== 'issue' && !item.pinned) return false;
    if (q) return matchQ(item) && inScope(item);
    if (S.scope === 'cycle' || S.project) return item.kind === 'issue' && inScope(item);
    return item.listed || S.sel === item.id;
  };
  const row = (item) => itemRow(item, prHit(item));
  // Offered only when nothing has that number, as an issue or one of its PRs.
  const found = num && S.snap.items.some((item) => item.number === Number(num) || prHit(item) !== null);
  let html = '';
  const blocked = S.snap.items.filter((item) => item.status === 'blocked' && shown(item));
  if (blocked.length) html += `<div class="grp"><span>Necesitan a alguien</span><span class="n alert">${blocked.length}</span></div>` + blocked.map(row).join('');
  // The portal's requests still going (#132): not searched, and only the running ones while filtering by that.
  const pedidos = (S.snap.pedidos ?? []).filter((p) => !q && (S.filter !== 'running' || p.running));
  if (pedidos.length) html += `<div class="grp"><span>Pedidos en curso</span><span class="n">${pedidos.length}</span></div>` + pedidos.map(pedRow).join('');
  for (const repo of S.snap.repos) {
    const items = S.snap.items.filter((item) => item.repo === repo && item.status !== 'blocked' && shown(item)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    html += `<div class="grp"><span class="sq" style="background:${repoColor(repo)}"></span><b>${esc(repoShort(repo))}</b><span class="n">${items.length}</span><button class="grp-add" data-new="${esc(repo)}" title="Nuevo issue en ${esc(repoShort(repo))}" aria-label="Nuevo issue en ${esc(repoShort(repo))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>`;
    html += items.length ? items.map(row).join('') : `<div class="grp-empty">${q || S.filter ? 'Nada coincide.' : S.scope === 'cycle' || S.project ? `Ningún issue abierto ${S.scope === 'cycle' ? 'en este ciclo' : ''}${S.project ? ' para este proyecto' : ''}.` : 'Nada en curso ni corridas en los últimos 3 días.'}</div>`;
    // A number nothing listed has: open it anyway (a closed issue, a PR without an issue).
    if (num && !found && safeRepo(repo)) {
      html += `<button class="item open-n" data-id="${esc(`${repo}#${num}`)}"><span class="dot pending" aria-hidden="true"></span><span class="t">Abrir #${esc(num)}</span><span class="sub">${esc(repoShort(repo))}, aunque esté cerrado o no tenga issue</span></button>`;
    }
  }
  tree.innerHTML = html;
  for (const button of tree.querySelectorAll('[data-id]')) button.onclick = () => select(button.dataset.id);
  for (const button of tree.querySelectorAll('[data-ped]')) button.onclick = () => openPedido(Number(button.dataset.ped));
  for (const button of tree.querySelectorAll('[data-new]')) button.onclick = () => openNewIssue(button.dataset.new);
}

// ---------- markdown from GitHub
// Whatever comes from GitHub (a PR from anyone, a comment) is untrusted: it's
// parsed by marked and then cleaned by DOMPurify before it reaches the page.
// Images become links (the CSP wouldn't load them anyway), except the
// screenshots ronin publishes, which the server reads from its own clone
// (/api/evidence); links open outside, and a #123 opens that item here when
// the sidebar has it.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
});
const mdCache = new Map();

// A screenshot ronin published (evidenceUrl in src/app/evidence-store.ts) of
// a repo on the dashboard, as the server serves it from its clone.
function evidenceSrc(src) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([0-9a-f]{7,40})\/([^?#]+)\?raw=true$/.exec(src ?? '');
  if (!m || !S.snap?.repos?.includes(m[1])) return null;
  return `/api/evidence/${m[1]}/${m[2]}/${m[3]}`;
}

function md(text, repo) {
  const key = `${repo}\n${text}`;
  if (mdCache.has(key)) return mdCache.get(key);
  const clean = DOMPurify.sanitize(marked.parse(text ?? '', { gfm: true, breaks: true }), { FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'iframe', 'video', 'audio'], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const img of tpl.content.querySelectorAll('img')) {
    const link = document.createElement('a');
    link.href = img.getAttribute('src') ?? '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const label = `[imagen${img.alt ? `: ${img.alt}` : ''}]`;
    const local = evidenceSrc(img.getAttribute('src'));
    if (local) {
      // The link still opens it on GitHub; if it doesn't load here, the label
      // takes its place (the 'error' listener in boot).
      img.src = local;
      img.className = 'ev';
      img.loading = 'lazy';
      img.dataset.label = label;
      img.replaceWith(link);
      link.append(img);
    } else {
      link.textContent = label;
      img.replaceWith(link);
    }
  }
  if (safeRepo(repo)) linkRefs(tpl.content, repo);
  const html = tpl.innerHTML;
  if (mdCache.size > 200) mdCache.clear();
  mdCache.set(key, html);
  return html;
}

function linkRefs(root, repo) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = [];
  while (walker.nextNode()) if (/(^|[^\w&/])#\d+\b/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    for (const m of text.matchAll(/(^|[^\w&/])#(\d+)\b/g)) {
      const at = m.index + m[1].length;
      frag.append(text.slice(last, at));
      const link = document.createElement('a');
      link.href = `https://github.com/${repo}/issues/${m[2]}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dataset.ref = `${repo}#${m[2]}`;
      link.textContent = `#${m[2]}`;
      frag.append(link);
      last = at + m[2].length + 1;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

// ---------- center
function step(line) {
  if (line.type === 'text') return `<div class="say">${esc(line.text)}</div>`;
  if (line.type === 'tool_error') return `<div class="out">${esc(line.text)}</div>`;
  if (line.type === 'tool') {
    const summary = String(line.summary ?? '').replace(/^\$ /, '');
    return `<div class="step"><b>${esc(VERB[line.name] ?? line.name)}</b> <span class="arg">${esc(summary)}</span></div>`;
  }
  return '';
}

function ending(summary) {
  const extra = [summary.durationMs !== undefined ? duration(summary.durationMs) : null, summary.costUsd !== undefined ? money(summary.costUsd) : null].filter(Boolean).join(', ');
  switch (summary.state) {
    case 'ok': return `<div class="end ok"><b>Terminó bien.</b> ${esc(extra)}</div>`;
    case 'timeout': return `<div class="end crit"><b>Se pasó del tiempo límite</b> y se cortó. ${esc(extra)}</div>`;
    case 'usage_limit': return `<div class="end warn"><b>Se quedó sin cuota de Claude.</b> Se reintenta cuando la cuenta se reinicie.</div>`;
    case 'cut': return `<div class="end crit"><b>Se cortó:</b> el proceso de ronin terminó sin cerrar la corrida.</div>`;
    case 'error': return `<div class="end crit"><b>Falló.</b> ${esc(summary.error ?? '')}</div>`;
    default: return '';
  }
}

function backBar(title) {
  return `<button class="back" id="back"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span>${esc(title)}</span></button>`;
}

// A run's task, and the PR it was on when that's not the item itself: an
// issue's history carries its slices' PR runs too (/resolve-conflicts on #849).
const runName = (item, run) => typeName(run.taskType) + (run.issueNumber == null && run.prNumber != null && run.prNumber !== item.number ? ` en #${run.prNumber}` : '');
const itemRuns = (item) => S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
// The item's page by default; the transcript for what has no page (a changelog entry).
const viewOf = (item) => S.view[item.id] ?? (item.kind === 'other' ? 'tx' : 'ficha');

function renderCenter() {
  const center = $('#center');
  const tabs = `<div class="tabs" role="tablist">${S.open.map((id) => {
    const item = itemById(id);
    const label = item ? item.title : id;
    return `<div class="tab" role="tab" aria-selected="${S.sel === id}"><button class="open" data-tab="${esc(id)}">${item ? dot(item.status) : ''}<span class="l">${esc(label)}</span></button><button class="x" data-close="${esc(id)}" aria-label="Cerrar">×</button></div>`;
  }).join('')}</div>`;

  const item = S.sel && itemById(S.sel);
  if (!item || viewOf(item) === 'tx') $('#shell').classList.remove('wide');
  if (!item && (S.page === 'pedidos' || S.page === 'pedido')) {
    // A request's page takes the room of the context column.
    $('#shell').classList.toggle('wide', S.page === 'pedido');
    // Redrawn on every snapshot: whoever was reading further down stays there.
    const scroller = $('#center .pd-body') ?? $('#center .today.pd');
    const keep = scroller?.scrollTop ?? 0;
    if (setCenter(backBar(S.page === 'pedido' ? `Pedido P-${S.ped.n}` : 'Portal de pedidos') + (S.page === 'pedido' ? pedidoHTML() : pedidosHTML()))) {
      wirePedidos();
      const fresh = $('#center .pd-body') ?? $('#center .today.pd');
      if (fresh && !isMobile()) fresh.scrollTop = keep;
    }
    return;
  }
  if (!item && (S.page === 'reuniones' || S.page === 'reunion')) {
    $('#shell').classList.toggle('wide', S.page === 'reunion');
    const scroller = $('#center .pd-body') ?? $('#center .today.pd');
    const keep = scroller?.scrollTop ?? 0;
    if (setCenter(backBar(S.page === 'reunion' ? `Reunión R-${S.reu.n}` : 'Reuniones') + (S.page === 'reunion' ? reunionHTML() : reunionesHTML()))) {
      wireReuniones();
      const fresh = $('#center .pd-body') ?? $('#center .today.pd');
      if (fresh && !isMobile()) fresh.scrollTop = keep;
    }
    return;
  }
  if (!item && S.page === 'portal') {
    if (setCenter(backBar('Portal de pedidos') + portalHTML())) {
      wirePortal();
      wirePedidos();
    }
    return;
  }
  if (!item) {
    setCenter(tabs + backBar('Hoy') + renderToday());
    wireToday();
    return;
  }
  if (viewOf(item) === 'tx') {
    renderTranscript(item, tabs);
    return;
  }
  // Redrawn on every snapshot: whoever was reading further down stays there.
  const doc = $('#doc');
  const keep = doc && doc.dataset.key === docKeyOf(item) ? doc.scrollTop : 0;
  const rows = $('#frows')?.scrollTop ?? 0;
  const fd = $('#fdetail');
  const fdKeep = fd ? { ficha: fd.dataset.current, top: fd.scrollTop } : null;
  const fdiffs = $('#fdiffs')?.scrollTop;
  const ftrows = $('#ftrows')?.scrollTop;
  // Reviewing findings or a diff takes the room of the context column.
  $('#shell').classList.toggle('wide', ['fichas', 'files'].includes(docOf(item)));
  // A box being written in survives the redraw (a finding's comment, a comment on the diff).
  const typing = ['fcomment', 'fcbox', 'rsum'].includes(document.activeElement?.id) ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  if (!setCenter(tabs + backBar(item.title) + headHTML(item) + activityHTML(item) + docHTML(item) + reviewPanelHTML(item) + `<div class="ctx-inline">${ctxHTML(item)}</div>`)) return;
  const fresh = $('#doc');
  if (fresh && !isMobile()) fresh.scrollTop = keep;
  if ($('#frows')) $('#frows').scrollTop = rows;
  if ($('#fdiffs') && fdiffs !== undefined) $('#fdiffs').scrollTop = fdiffs;
  if ($('#ftrows') && ftrows !== undefined) $('#ftrows').scrollTop = ftrows;
  const fdFresh = $('#fdetail');
  if (fdFresh && fdKeep && fdFresh.dataset.current === fdKeep.ficha) fdFresh.scrollTop = fdKeep.top;
  const box = typing && document.getElementById(typing.id);
  if (box) {
    box.focus();
    box.setSelectionRange(typing.start, typing.end);
  }
}

// Only touches the page when something changed, so a snapshot that changes
// nothing doesn't reset a selection or a scroll. False when it was the same.
function setCenter(html) {
  const center = $('#center');
  if (center._html === html) return false;
  center._html = html;
  center.innerHTML = html;
  tickClocks();
  wireCenter();
  return true;
}

function renderTranscript(item, tabs) {
  const runs = itemRuns(item);
  const back = item.kind !== 'other' ? '<button class="pill back-ficha" data-view="ficha">← Ficha</button>' : '';
  if (runs.length === 0) {
    const loading = !(item.id in S.itemRuns);
    setCenter(tabs + backBar(item.title) + (back ? `<div class="runs">${back}</div>` : '') + `<div class="tx"><div class="empty">${loading ? 'Cargando…' : '<b>Sin corridas de agentes en los últimos 14 días</b>'}</div></div><div class="ctx-inline">${ctxHTML(item)}</div>`);
    return;
  }
  const index = Math.min(S.runIdx[item.id] ?? 0, runs.length - 1);
  const pills = `<div class="runs">${back}<span class="lbl">Corridas</span>${runs.map((run, i) => `<button class="pill" data-run="${i}" aria-pressed="${i === index}">${dot(run.state)}${esc(runName(item, run))}<span class="m">${run.state === 'running' ? 'en curso' : `${hhmm(run.startedAt)}${run.durationMs !== undefined ? `, ${duration(run.durationMs)}` : ''}`}</span></button>`).join('')}</div>`;

  const shown = runs[index];
  const loaded = S.run && S.run.runId === shown.runId ? S.run : null;
  let body;
  if (!loaded) {
    body = `<div class="tx"><div class="empty">Cargando la corrida…</div></div>`;
  } else {
    const steps = loaded.lines.map(step).join('');
    body = `<div class="tx" id="tx">${steps || '<div class="empty">El agente todavía no hizo nada.</div>'}${ending(loaded.summary)}</div>
      <div class="foot">${loaded.summary.state === 'running'
        ? `<span class="w">● Trabajando</span><span data-since="${esc(loaded.summary.startedAt)}"></span>`
        : `<span>${esc(STATE[loaded.summary.state]?.[2] ?? loaded.summary.state)}</span>`}<span>${esc(typeName(loaded.summary.taskType))}</span><span class="r">${esc([loaded.summary.model, loaded.summary.worktree].filter(Boolean).join('  '))}</span></div>`;
  }
  // Whoever was reading further up stays there, whoever was at the bottom
  // of a run still going follows it.
  const tx = $('#tx');
  const sameRun = tx && tx.dataset.run === loaded?.runId;
  const atBottom = !sameRun || tx.scrollTop + tx.clientHeight >= tx.scrollHeight - 30;
  const scrollTop = sameRun ? tx.scrollTop : 0;
  if (!setCenter(tabs + backBar(item.title) + pills + body + `<div class="ctx-inline">${ctxHTML(item)}</div>`)) return;
  const fresh = $('#tx');
  if (!fresh) return;
  if (loaded) fresh.dataset.run = loaded.runId;
  if (isMobile()) return;
  fresh.scrollTop = atBottom ? fresh.scrollHeight : scrollTop;
}

// ---------- the item's page (#85)
function checksChip(checks) {
  if (!checks?.length) return null;
  const failed = checks.filter((c) => c.outcome === 'failed').length;
  if (failed) return ['crit', `${failed} ${failed === 1 ? 'check falla' : 'checks fallan'}`];
  if (checks.some((c) => c.outcome === 'pending')) return ['run', 'checks corriendo'];
  return ['ok', `checks ${checks.length}/${checks.length}`];
}

function headHTML(item) {
  const url = githubUrl(item);
  const [, chip, label] = STATE[item.status] ?? STATE.error;
  const d = S.detail[item.id]?.data;
  const pr = item.pr;
  const prDoc = d?.pr;
  // For an issue, what's said about its PR is said with the PR's number.
  const of = item.kind === 'issue' && pr ? `#${pr.number}: ` : '';
  // A run's outcome is in the activity line, not here: "terminó bien" next to "conflictos" would read as the PR's.
  const chips = ['running', 'blocked', 'waiting'].includes(item.status) ? [[chip, label]] : [];
  if (prDoc?.mergeable === 'CONFLICTING') chips.push(['crit', `${of}conflictos con ${prDoc.baseRefName}`]);
  const checks = checksChip(pr?.checks);
  if (checks) chips.push([checks[0], of + checks[1]]);
  if (pr?.reviewDecision === 'APPROVED') chips.push(['ok', `${of}aprobado`]);
  else if (pr?.reviewDecision === 'CHANGES_REQUESTED') chips.push(['warn', `${of}cambios pedidos`]);
  if (pr?.isDraft) chips.push(['idle', `${of}draft`]);
  const facts = [];
  if (item.slices?.length) facts.push(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} slices mergeadas`);
  if (item.note && item.status !== 'running') facts.push(item.note);
  if (item.kind === 'pr' && prDoc?.headRefName) facts.push(`${prDoc.headRefName} → ${prDoc.baseRefName}`);
  if (item.kind === 'pr' && pr?.author) facts.push(`de ${pr.author}`);
  return `<div class="head">
    <div class="crumb"><i style="background:${repoColor(item.repo)}"></i>${esc(item.repo)} · ${item.kind === 'pr' ? 'Pull request' : item.kind === 'issue' ? 'Issue' : 'Tarea'}</div>
    <div class="row"><h1>${esc(item.title)}${item.number !== undefined ? ` <span class="n">${esc(itemRef(item))}</span>` : ''}</h1>${url ? `<a class="gh" href="${esc(url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}${safeLinear((item.linear ?? d?.linear)?.url) ? `<a class="gh" href="${esc((item.linear ?? d.linear).url)}" target="_blank" rel="noopener" title="El issue en Linear">${esc((item.linear ?? d.linear).id)} ↗</a>` : ''}${d?.exploration ? '<button class="gh" data-xpr="general">Comentario general</button>' : ''}${reviewable(item, d) ? (pendingOf(item.id).length ? `<button class="act-btn" data-frev>Terminar revisión <span class="rn">${pendingOf(item.id).length}</span></button>` : `<button class="gh" data-frev>${esc(reviewLabel(item, d))}</button>`) : ''}${actionsHTML(d)}${d?.exploration ? '<button class="act-btn" data-xpr="approve">Aprobar…</button>' : ''}</div>
    <div class="state">${ghPill(item, d)}${d?.pedido ? `<button class="chip plain" data-goped="${d.pedido.number}" title="${esc(d.pedido.title)}">del pedido P-${d.pedido.number}</button>` : ''}${linearChips(item)}${chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('')}${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>`;
}

// ---------- actions (#85)
// Each one is a command that exists on GitHub, commented as whoever is
// logged in (#93): the same comment they'd write there.
// Its project and cycle in Linear (#101), for a repo with a Linear key.
function linearChips(item) {
  const l = item.linear;
  if (!l) return '';
  const project = l.project ? `<span class="chip plain"><i class="pdot" style="background:${projectColor(l.project.id)};margin:0"></i>${esc(l.project.name)}</span>` : '<span class="chip plain">sin proyecto</span>';
  const cycle = l.cycle ? `<span class="chip ${l.cycle.current ? 'run' : 'plain'}">${esc(cycleName(l.cycle))}${l.cycle.current ? ', el actual' : ''}</span>` : '<span class="chip plain">sin ciclo</span>';
  return project + cycle;
}

function actionsHTML(d) {
  if (!d?.actions?.length) return '';
  const menu = S.menu ? `<div class="menu" role="menu">${d.actions.map((a) => `<button role="menuitem" data-action="${esc(a.id)}" class="${a.primary ? 'primary' : ''}"><b>${esc(a.label)}</b><span class="k">${esc(a.command)}</span><small>${esc(a.help)}</small></button>`).join('')}</div>` : '';
  return `<div class="actions"><button class="act-btn" id="act" aria-haspopup="menu" aria-expanded="${S.menu}">Acciones ▾</button>${menu}</div>`;
}

function openAction(id) {
  const action = S.detail[S.sel]?.data?.actions?.find((a) => a.id === id);
  if (!action) return;
  S.menu = false;
  S.dialog = { item: S.sel, action, text: '', sending: false, error: null };
  renderCenter();
  renderDialog();
}

function renderDialog() {
  let layer = $('#layer');
  if (!S.dialog) {
    layer?.remove();
    return;
  }
  if (!layer) layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'layer' });
  const { action, text, sending, error } = S.dialog;
  // `…` stands for the text: filled as it's typed, left out when the text is optional and empty.
  const typed = text.trim();
  const preview = !action.text ? action.preview : typed ? action.preview.replace('…', typed) : action.text.required ? action.preview : action.preview.replace(/\n\n…$/, '');
  const fresh = !layer.firstChild;
  if (fresh) {
    layer.innerHTML = `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">${esc(action.label)}</h2>
      <p class="help">${esc(action.help)}</p>
      ${action.text ? `<label class="field"><span>${esc(action.text.label)}</span><textarea id="dlg-text" rows="4" maxlength="4000" placeholder="${esc(action.text.placeholder)}"></textarea></label>` : ''}
      <div class="prev"><div class="lbl">Comentás en #${esc(action.target)} como ${esc(S.snap?.me ?? '')}</div><div class="md" id="dlg-prev"></div></div>
      <p class="bad" id="dlg-err" hidden></p>
      <div class="foot-d"><button class="btn-s" id="dlg-no">Cancelar</button><button class="btn-s primary" id="dlg-yes"></button></div></div></div>`;
    const area = $('#dlg-text');
    if (area) area.oninput = () => { S.dialog.text = area.value; renderDialog(); };
    $('#dlg-no').onclick = closeDialog;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeDialog(); };
    $('#dlg-yes').onclick = sendAction;
    (area ?? $('#dlg-yes')).focus();
  }
  $('#dlg-prev').innerHTML = md(preview, itemById(S.dialog.item)?.repo ?? '');
  const yes = $('#dlg-yes');
  yes.textContent = sending ? 'Comentando…' : action.id === 'unblock' ? 'Comentar y destrabar' : 'Comentar';
  yes.disabled = sending || Boolean(action.text?.required && !text.trim());
  $('#dlg-err').hidden = !error;
  $('#dlg-err').textContent = error ?? '';
}

function closeDialog() {
  if (S.dialog?.sending) return;
  S.dialog = null;
  renderDialog();
}

async function sendAction() {
  const dialog = S.dialog;
  if (!dialog || dialog.sending) return;
  dialog.sending = true;
  dialog.error = null;
  renderDialog();
  try {
    const { url } = await api(`/api/items/${encodeURIComponent(dialog.item)}/actions`, { method: 'POST', body: JSON.stringify({ action: dialog.action.id, ...(dialog.text.trim() ? { text: dialog.text.trim() } : {}) }) });
    S.dialog = null;
    renderDialog();
    toast(`Listo: comentaste en #${dialog.action.target}.`, url);
    const item = itemById(dialog.item);
    // Its comment is where the answer will come: shown when it's this item's own.
    if (item && item.number === dialog.action.target) S.doc[dialog.item] = 'comments';
    if (S.detail[dialog.item]) S.detail[dialog.item].at = 0;
    await loadDetail(dialog.item);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    dialog.sending = false;
    dialog.error = `No se pudo: ${error.message}`;
    renderDialog();
  }
}

// ---------- new issue (#100)
// Created on GitHub as the person (never through Linear), and then, if
// asked, assigned to ronin or with a /spike or /spec commented as them.
const AFTER = [
  ['none', 'Solo crearlo', 'Queda en GitHub (y en Linear, por la sincronización) para quien lo tome.'],
  ['assign', 'Asignárselo a ronin', 'ronin lo toma como cualquier issue que le asignan: lo investiga, pregunta si le falta algo y abre un PR.'],
  ['spike', 'Pedir un /spike', 'ronin investiga en solo lectura y agrega una sección de contexto al issue.'],
  ['spec', 'Pedir un /spec', 'ronin lo convierte en un spec, te pregunta lo que falte y abre un PR draft con el spec.'],
];

function openNewIssue(repo) {
  const apps = S.snap?.apps?.[repo] ?? [];
  S.newIssue = { repo, title: '', body: '', after: 'none', app: apps[0] ?? '', instruction: '', projectId: '', cycleId: '', tab: 'write', sending: false, error: null };
  renderNewIssue();
}

function closeNewIssue() {
  if (S.newIssue?.sending) return;
  S.newIssue = null;
  renderNewIssue();
}

function renderNewIssue() {
  let layer = $('#nlayer');
  const n = S.newIssue;
  if (!n) {
    layer?.remove();
    return;
  }
  const apps = S.snap?.apps?.[n.repo] ?? [];
  // With Linear (#101): the project and the cycle it goes in, both optional.
  const planning = linearRepos().find((l) => l.repo === n.repo)?.planning;
  const cycleLabel = (c) => `${cycleName(c)}${c.current ? ', el actual' : ''} (${dayMonth(c.startsAt)} – ${endDay(c.endsAt)})`;
  if (!layer) {
    layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'nlayer' });
    layer.innerHTML = `<div class="scrim"><div class="dlg dlg-new" role="dialog" aria-modal="true" aria-labelledby="ni-t">
      <h2 id="ni-t">Nuevo issue en ${esc(repoShort(n.repo))}</h2>
      <p class="help">Se crea en GitHub a tu nombre (${esc(S.snap?.me ?? '')}).${linearRepos().some((l) => l.repo === n.repo) ? ' Con la sincronización, aparece también en Linear.' : ''}</p>
      <label class="field"><span>Título</span><input id="ni-title" maxlength="256" autocomplete="off" placeholder="Qué pasa o qué hace falta"></label>
      <div class="field"><div class="ni-tabs" role="tablist"><span>Descripción</span><button role="tab" data-nitab="write">Escribir</button><button role="tab" data-nitab="preview">Vista previa</button></div>
        <textarea id="ni-body" rows="7" placeholder="Contexto, pasos para reproducirlo, qué se espera. Acepta markdown."></textarea><div class="md ni-prev" id="ni-prev" hidden></div></div>
      ${planning ? `<div class="ni-linear"><label class="field"><span>${LIN_ICON} Proyecto</span><select id="ni-project"><option value="">Sin proyecto</option>${planning.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>${LIN_ICON} Ciclo</span><select id="ni-cycle"><option value="">Sin ciclo</option>${planning.cycles.map((c) => `<option value="${esc(c.id)}">${esc(cycleLabel(c))}</option>`).join('')}</select></label></div>` : ''}
      <fieldset class="ni-after"><legend>Después de crearlo</legend>
        ${AFTER.map(([id, label, help]) => {
          const off = (id === 'spike' || id === 'spec') && !apps.length;
          return `<label class="check"><input type="radio" name="ni-after" value="${id}" ${off ? 'disabled' : ''}><span>${esc(label)}<small>${esc(off ? 'El repo no tiene ronin.app.json: no hay apps para pedirlo.' : help)}</small></span></label>`;
        }).join('')}
      </fieldset>
      <div class="ni-cmd" id="ni-cmd" hidden>
        <label class="field"><span>App</span><select id="ni-app">${apps.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
        <label class="field"><span>Instrucción (opcional)</span><input id="ni-instr" maxlength="500" autocomplete="off" placeholder="En qué fijarse"></label>
        <div class="prev"><div class="lbl">Comentás en el issue como ${esc(S.snap?.me ?? '')}</div><code id="ni-line"></code></div>
      </div>
      <p class="bad" id="ni-err" hidden></p>
      <div class="foot-d"><button class="btn-s" id="ni-no">Cancelar</button><button class="btn-s primary" id="ni-yes"></button></div></div></div>`;
    const bind = (sel, key) => { $(sel).oninput = (e) => { S.newIssue[key] = e.target.value; renderNewIssue(); }; };
    bind('#ni-title', 'title');
    bind('#ni-body', 'body');
    bind('#ni-instr', 'instruction');
    $('#ni-app').onchange = (e) => { S.newIssue.app = e.target.value; renderNewIssue(); };
    if (planning) {
      $('#ni-project').onchange = (e) => { S.newIssue.projectId = e.target.value; };
      $('#ni-cycle').onchange = (e) => { S.newIssue.cycleId = e.target.value; };
    }
    for (const radio of layer.querySelectorAll('[name="ni-after"]')) radio.onchange = () => { S.newIssue.after = radio.value; renderNewIssue(); };
    for (const tab of layer.querySelectorAll('[data-nitab]')) tab.onclick = () => { S.newIssue.tab = tab.dataset.nitab; renderNewIssue(); };
    $('#ni-no').onclick = closeNewIssue;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeNewIssue(); };
    $('#ni-yes').onclick = sendNewIssue;
    $('#ni-title').focus();
  }
  for (const radio of layer.querySelectorAll('[name="ni-after"]')) radio.checked = radio.value === n.after;
  for (const tab of layer.querySelectorAll('[data-nitab]')) tab.setAttribute('aria-selected', String(tab.dataset.nitab === n.tab));
  const preview = n.tab === 'preview';
  $('#ni-body').hidden = preview;
  $('#ni-prev').hidden = !preview;
  if (preview) $('#ni-prev').innerHTML = n.body.trim() ? md(n.body, n.repo) : '<p class="note">Sin descripción.</p>';
  const command = n.after === 'spike' || n.after === 'spec';
  $('#ni-cmd').hidden = !command;
  if (command) $('#ni-line').textContent = `@${S.snap?.ronin ?? 'ronin'} /${n.after} ${n.app}${n.instruction.trim() ? ` ${n.instruction.trim().replace(/\s+/g, ' ')}` : ''}`;
  const yes = $('#ni-yes');
  yes.textContent = n.sending ? 'Creando…' : n.after === 'assign' ? 'Crear y asignar a ronin' : command ? `Crear y pedir /${n.after}` : 'Crear issue';
  yes.disabled = n.sending || !n.title.trim() || (command && !n.app);
  $('#ni-err').hidden = !n.error;
  $('#ni-err').textContent = n.error ?? '';
}

async function sendNewIssue() {
  const n = S.newIssue;
  if (!n || n.sending || !n.title.trim()) return;
  n.sending = true;
  n.error = null;
  renderNewIssue();
  try {
    const command = n.after === 'spike' || n.after === 'spec';
    const created = await api(`/api/repos/${n.repo}/issues`, { method: 'POST', body: JSON.stringify({ title: n.title, body: n.body, after: n.after, ...(command ? { app: n.app, instruction: n.instruction } : {}), ...(n.projectId ? { projectId: n.projectId } : {}), ...(n.cycleId ? { cycleId: n.cycleId } : {}) }) });
    S.newIssue = null;
    renderNewIssue();
    toast(`Listo: creaste #${created.number}${n.after === 'assign' ? ' y se lo asignaste a ronin' : command ? ` y pediste /${n.after}` : ''}.${n.projectId || n.cycleId ? ' El proyecto y el ciclo se le ponen en Linear apenas la sincronización lo cree allá.' : ''}`, created.url);
    await refresh();
    select(created.id);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    n.sending = false;
    n.error = `No se pudo: ${error.message}`;
    renderNewIssue();
  }
}

function toast(message, url) {
  // The newest says it all: one on top of another can't be read.
  for (const old of document.querySelectorAll('.toast')) old.remove();
  const el = Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toast', role: 'status' });
  el.innerHTML = `${esc(message)}${url && url.startsWith('https://github.com/') ? ` <a href="${esc(url)}" target="_blank" rel="noopener">Ver ↗</a>` : ''}`;
  setTimeout(() => el.remove(), 5000);
}

function activityHTML(item) {
  const runs = itemRuns(item);
  const loading = !(item.id in S.itemRuns);
  if (runs.length === 0) return `<div class="activity"><div class="act-line"><span class="lbl">Actividad</span><span class="m">${loading ? 'Cargando…' : 'Sin corridas de agentes en los últimos 14 días.'}</span></div></div>`;
  const latest = runs[0];
  // The latest run is the line itself (or the card below it); the older ones, pills that open their transcript.
  const older = runs.slice(1).map((run, i) => `<button class="pill" data-runview="${i + 1}">${dot(run.state)}${esc(runName(item, run))}<span class="m">${esc(short(Date.now() - Date.parse(run.endedAt ?? run.startedAt)))}</span></button>`).join('');
  let summary = '';
  if (latest.state !== 'running') {
    const [, , label] = STATE[latest.state] ?? STATE.error;
    const facts = [label, `hace ${short(Date.now() - Date.parse(latest.endedAt ?? latest.startedAt))}`, latest.durationMs !== undefined ? duration(latest.durationMs) : null, latest.costUsd !== undefined ? money(latest.costUsd) : null].filter(Boolean).join(' · ');
    summary = `<span class="latest">${dot(latest.state)}<b>${esc(runName(item, latest))}</b><span class="m">${esc(facts)}</span></span>`;
  }
  const line = `<div class="act-line"><span class="lbl">Actividad</span>${summary}${older ? `<span class="pills">${older}</span>` : ''}<span class="sp"><button class="link" data-runview="0">transcript →</button></span></div>`;
  if (latest.state !== 'running') return `<div class="activity">${line}${latest.state === 'error' && latest.error ? `<div class="last-err">${esc(latest.error)}</div>` : ''}</div>`;
  // The run going on: what the agent last said and its last few steps.
  const lines = S.run?.runId === latest.runId ? S.run.lines : [];
  const said = [...lines].reverse().find((l) => l.type === 'text');
  const steps = lines.filter((l) => l.type === 'tool').slice(-4);
  return `<div class="activity">${line}<div class="livecard"><div class="top">${dot('running')}<b>${esc(runName(item, latest))}${latest.sliceIndex !== undefined ? `, slice ${latest.sliceIndex + 1}` : ''}</b><span class="clk" data-since="${esc(latest.startedAt)}"></span>${latest.model ? `<span class="m">${esc(latest.model)}</span>` : ''}</div>
    ${said ? `<div class="say">${esc(said.text)}</div>` : ''}
    ${steps.length ? `<ol>${steps.map((l) => `<li><b>${esc(VERB[l.name] ?? l.name)}</b> <span class="arg">${esc(String(l.summary ?? '').replace(/^\$ /, ''))}</span></li>`).join('')}</ol>` : `<div class="m">${S.run?.runId === latest.runId ? 'Arrancando…' : 'Cargando…'}</div>`}</div></div>`;
}

function docTabsOf(item, d) {
  // Archivos: the PR's "Files changed" (#111), an issue's moving PR's.
  if (item.kind === 'issue') return [['issue', 'Issue'], ...(d?.pr ? [['pr', `PR #${d.pr.number}`]] : []), ['comments', 'Comentarios'], ...(d?.pr ? [['files', 'Archivos']] : [])];
  // An exploration PR opens on its findings, to review them (#93).
  return [...(d?.exploration ? [['fichas', 'Fichas']] : []), ['pr', 'Descripción'], ...(d?.issue ? [['issue', `Issue #${d.issue.number}`]] : []), ['comments', 'Comentarios'], ['files', 'Archivos']];
}
const docOf = (item) => {
  const d = S.detail[item.id]?.data;
  if (!d) return null;
  const tabs = docTabsOf(item, d);
  return tabs.some(([k]) => k === S.doc[item.id]) ? S.doc[item.id] : tabs[0][0];
};
// The tab shown, the same docHTML marks #doc with: on the default tab
// S.doc is still empty, and comparing against it lost the scroll on every
// redraw.
const docKeyOf = (item) => `${item.id}:${docOf(item) ?? ''}`;

function docHTML(item) {
  if (item.kind === 'other') return '';
  const entry = S.detail[item.id];
  const d = entry?.data;
  if (!d) return `<div class="doc" id="doc"><div class="empty">${entry?.error ? `No se pudo leer de GitHub: ${esc(entry.error)}` : 'Cargando de GitHub…'}</div></div>`;
  const tabs = docTabsOf(item, d);
  const cur = tabs.some(([k]) => k === S.doc[item.id]) ? S.doc[item.id] : tabs[0][0];
  const own = item.kind === 'issue' ? d.issue : d.pr;
  const entries = own ? conversation(own) : [];
  const count = entries.length;
  const fichas = S.expl[item.id]?.data?.fichas;
  const files = S.files[item.id];
  const counter = (k) => (k === 'comments' ? `<span class="c">${count}</span>` : k === 'fichas' && fichas ? `<span class="c">${fichas.length}</span>` : k === 'files' && files?.data ? `<span class="c">${files.data.files.length}</span>` : '');
  const bar = `<div class="doctabs" role="tablist">${tabs.map(([k, label]) => `<button class="doctab" role="tab" data-doc="${k}" aria-selected="${k === cur}">${esc(label)}${counter(k)}</button>`).join('')}
    ${cur === 'fichas' ? '<span class="keys"><kbd>j</kbd> <kbd>k</kbd> otra ficha</span>' : cur === 'files' ? '<span class="keys"><kbd>j</kbd> <kbd>k</kbd> otro archivo · <kbd>v</kbd> visto · <kbd>r</kbd> revisión</span>' : ''}<span class="src">${d.error ? `<span class="bad">GitHub no respondió: ${esc(d.error)}</span>, ` : ''}${d.fetchedAt ? `leído hace ${esc(short(Date.now() - Date.parse(d.fetchedAt)))}` : ''}</span></div>`;
  if (cur === 'fichas') return bar + fichasHTML(item);
  if (cur === 'files') {
    // Read when the tab is first shown, and again once old (refresh).
    if (!files) queueMicrotask(() => loadFiles(item.id));
    return bar + filesHTML(item);
  }
  let body;
  if (cur === 'comments') {
    body = count
      ? `<div class="comments">${entries.map((e) => entryHTML(e, d, own, item.repo)).join('')}</div>`
      : '<div class="empty">Nadie comentó todavía.</div>';
  } else {
    const doc = cur === 'issue' ? d.issue : d.pr;
    const other = (cur === 'issue') !== (item.kind === 'issue');
    body = `<div class="page">${other ? `<a class="other" href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(doc.title)} <span class="m">${cur === 'pr' ? 'PR' : 'Issue'} #${esc(doc.number)} ↗</span></a>` : ''}
      <div class="meta">${avatar(doc.author)}<b>${esc(doc.author)}</b><span>${esc(when(doc.createdAt))}</span></div>
      <div class="md">${doc.body.trim() ? md(doc.body, item.repo) : '<p class="m">Sin descripción.</p>'}</div></div>`;
  }
  return bar + `<div class="doc" id="doc" data-key="${esc(`${item.id}:${cur}`)}">${body}</div>`;
}

// ---------- a PR's files (#111)
// "Files changed": the files on the left, their diffs on the right, each
// review thread under the line it's on. An issue's tab shows its moving PR's.
// Commenting, replying, resolving and "Viewed" are done as whoever is
// logged in, as in "Files changed" (POST /files/actions).
const BIG_DIFF_LINES = 400;
// How many unchanged lines each "show more" adds.
const MORE_LINES = 20;
const FILE_STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·' };
try { S.diffMode = localStorage.getItem('ronin-diff-mode') === 'split' ? 'split' : 'unified'; } catch { S.diffMode = 'unified'; }
const diffMode = () => (isMobile() ? 'unified' : S.diffMode);

// A patch's hunks, each line with its number in the old file (o) and the new one (n).
function parsePatch(patch) {
  const hunks = [];
  let hunk = null;
  let o = 0;
  let n = 0;
  for (const raw of (patch ?? '').split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (head) {
      o = Number(head[1]);
      n = Number(head[2]);
      hunk = { oldStart: o, newStart: n, ctx: head[3], lines: [] };
      hunks.push(hunk);
    } else if (hunk && !raw.startsWith('\\')) {
      const text = raw.slice(1);
      if (raw[0] === '+') hunk.lines.push({ t: 'add', n: n++, text });
      else if (raw[0] === '-') hunk.lines.push({ t: 'del', o: o++, text });
      else hunk.lines.push({ t: 'eq', o: o++, n: n++, text });
    }
  }
  for (const h of hunks) {
    h.newEnd = Math.max(h.newStart - 1, ...h.lines.filter((l) => l.n !== undefined).map((l) => l.n));
    h.oldEnd = Math.max(h.oldStart - 1, ...h.lines.filter((l) => l.o !== undefined).map((l) => l.o));
  }
  return hunks;
}
const hunksCache = new Map();
function hunksOf(file) {
  if (!hunksCache.has(file.patch)) hunksCache.set(file.patch, parsePatch(file.patch));
  return hunksCache.get(file.patch);
}

const contentKey = (id, path) => `${id}|${path}`;
const foldOf = (id) => (S.ffold[id] ??= {});
const viewedOf = (id) => S.files[id]?.viewed ?? new Set();
// The person's pending review on the PR: GitHub's own draft, only theirs.
const reviewOf = (id) => S.files[id]?.review ?? null;
const pendingOf = (id) => (reviewOf(id)?.threads ?? []).flatMap((t) => t.comments.map((c) => ({ t, c })));
// A file's threads as the person sees them: the PR's, with the replies their
// review adds, and the ones their review starts.
function threadsSeen(id, data, path) {
  const review = reviewOf(id);
  const replies = new Map((review?.threads ?? []).filter((t) => !t.isNew).map((t) => [t.id, t.comments]));
  const own = data.threads.filter((t) => t.path === path).map((t) => (replies.has(t.id) ? { ...t, pending: replies.get(t.id) } : t));
  const fresh = (review?.threads ?? []).filter((t) => t.isNew && t.path === path).map((t) => ({ ...t, isResolved: false, isOutdated: t.subject === 'line' && t.line === null, url: `pending:${t.id}`, comments: [], pending: t.comments, mine: true }));
  return [...own, ...fresh];
}
// A viewed file folds, like on GitHub; so does a big diff, until opened.
const isFolded = (id, file) => foldOf(id)[file.path] ?? (viewedOf(id).has(file.path) || file.additions + file.deletions > BIG_DIFF_LINES);

function filesHTML(item) {
  const entry = S.files[item.id];
  const data = entry?.data;
  if (!data) return `<div class="doc" id="doc"><div class="empty">${entry?.error ? `No se pudieron leer los archivos: ${esc(entry.error)}` : 'Leyendo los archivos de GitHub…'}</div></div>`;
  if (!data.files.length) return `<div class="doc" id="doc"><div class="empty">${data.error ? `GitHub no respondió: ${esc(data.error)}` : '<b>Este PR no cambia ningún archivo</b>'}</div></div>`;
  const cur = S.fcur[item.id] ?? data.files[0].path;
  const viewed = viewedOf(item.id);
  const threads = (path) => data.threads.filter((t) => t.path === path && !t.isResolved).length;
  const pendingIn = (path) => pendingOf(item.id).filter((x) => x.t.path === path).length;
  const q = (S.fq[item.id] ?? '').toLowerCase();
  const byDir = new Map();
  for (const f of data.files.filter((x) => !q || x.path.toLowerCase().includes(q))) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  const rows = [...byDir].map(([dir, files]) => (dir ? `<div class="fdir" title="${esc(dir)}"><bdi>${esc(dir)}/</bdi></div>` : '') + files.map((f) => {
    const open = threads(f.path);
    const seen = viewed.has(f.path);
    return `<button class="ffile${seen ? ' seen' : ''}" data-fgo="${esc(f.path)}" aria-current="${f.path === cur}"><span class="fst ${esc(f.status)}" title="${esc(f.status)}">${FILE_STATUS[f.status] ?? '?'}</span><span class="nm">${esc(f.path.split('/').pop())}</span>${pendingIn(f.path) ? `<span class="pd" title="${pendingIn(f.path)} en tu revisión">✎${pendingIn(f.path)}</span>` : ''}${open ? `<span class="talk" title="${open} sin resolver">${TALK_ICON}${open}</span>` : ''}${seen ? '<span class="ck" title="Visto">✓</span>' : `<span class="addel"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span>`}</button>`;
  }).join('')).join('');
  const add = data.files.reduce((s, f) => s + f.additions, 0);
  const del = data.files.reduce((s, f) => s + f.deletions, 0);
  const url = prUrl(item.repo, data.pr);
  const mode = (m, label) => `<button data-fmode="${m}" aria-pressed="${S.diffMode === m}">${label}</button>`;
  const seenCount = data.files.filter((f) => viewed.has(f.path)).length;
  const progress = `<div class="fseen"><span class="fprog-bar"><i style="width:${(seenCount / data.files.length) * 100}%"></i></span>${seenCount} de ${data.files.length} vistos</div>`;
  const tree = `<div class="ftree"><div class="ftop"><input type="search" id="fq" placeholder="Filtrar archivos" value="${esc(S.fq[item.id] ?? '')}" aria-label="Filtrar archivos"><button class="btn-s ftreex" data-ftree>Cerrar</button></div>${progress}<div class="frows" id="ftrows">${rows || '<p class="none">Ningún archivo coincide.</p>'}</div></div>`;
  const tool = `<div class="ftool"><button class="btn-s ftreebtn" data-ftree>Archivos ▾</button><span class="seg">${mode('unified', 'Unificado')}${mode('split', 'Lado a lado')}</span>
    <span>${data.files.length} ${data.files.length === 1 ? 'archivo' : 'archivos'} · <span class="addel"><span class="a">+${add}</span> <span class="d">−${del}</span></span></span>${data.error ? `<span class="bad">GitHub no respondió: ${esc(data.error)}</span>` : ''}
    <span class="m hint-c">Clic en un número de línea para comentarla</span>${reviewOf(item.id) ? `<button class="btn-s primary frevb" data-frev>Terminar revisión <span class="rn">${pendingOf(item.id).length}</span></button>` : reviewable(item, S.detail[item.id]?.data) ? '<button class="btn-s frevb" data-frev>Revisar</button>' : ''}${url ? `<a class="gh" href="${esc(url)}/files" target="_blank" rel="noopener">En GitHub ↗</a>` : ''}</div>`;
  return `<div class="doc files${S.ftree ? ' tree' : ''}" id="doc" data-key="${esc(`${item.id}:files`)}">${tree}<div class="fdiffs" id="fdiffs">${tool}<div class="fcards">${data.files.map((f) => fileHTML(item, data, f)).join('')}</div></div></div>`;
}

function fileHTML(item, data, file) {
  const folded = isFolded(item.id, file);
  const parts = file.path.split('/');
  const name = parts.pop();
  const own = threadsSeen(item.id, data, file.path);
  const seen = viewedOf(item.id).has(file.path);
  const header = `<header><button class="fold" data-ffold="${esc(file.path)}" aria-expanded="${!folded}" aria-label="${folded ? 'Abrir' : 'Plegar'}">${folded ? '▸' : '▾'}</button>
    <span class="p" title="${esc(file.path)}">${file.previousPath ? `<span>${esc(file.previousPath)} → </span>` : ''}<span>${esc(parts.length ? `${parts.join('/')}/` : '')}</span><b>${esc(name)}</b></span>
    <span class="addel"><span class="a">+${file.additions}</span> <span class="d">−${file.deletions}</span></span>
    <button class="btn-s fcfile" data-fcfile="${esc(file.path)}" title="Comentar el archivo entero">Comentar archivo</button>
    <label class="fviewed${seen ? ' on' : ''}"><input type="checkbox" data-fviewed="${esc(file.path)}"${seen ? ' checked' : ''}> Visto</label></header>`;
  const comp = S.fcomp?.item === item.id && S.fcomp.path === file.path && S.fcomp.subject === 'file' ? composerHTML(item, file) : '';
  if (folded) {
    const why = !seen && file.additions + file.deletions > BIG_DIFF_LINES && foldOf(item.id)[file.path] === undefined ? `<button class="fbig" data-ffold="${esc(file.path)}">Diff grande (${file.additions + file.deletions} líneas): abrirlo</button>` : '';
    return `<section class="fcard folded" id="${esc(fileAnchor(file.path))}" data-file="${esc(file.path)}">${header}${comp ? `<div class="ftop-threads">${comp}</div>` : ''}${why}</section>`;
  }
  const body = file.patch ? diffTable(item, file, own) : { html: `<p class="nodiff">GitHub no muestra el diff de este archivo${file.status === 'renamed' && !file.additions && !file.deletions ? ': solo se renombró' : ' (binario o demasiado grande)'}.</p>`, placed: new Set() };
  // On top: what's about the whole file, and what's on lines no longer in the diff.
  const top = own.filter((t) => !body.placed.has(t));
  const above = top.map((t) => diffThreadHTML(item, t, data)).join('') + comp;
  return `<section class="fcard" id="${esc(fileAnchor(file.path))}" data-file="${esc(file.path)}">${header}${above ? `<div class="ftop-threads">${above}</div>` : ''}${body.html}</section>`;
}
const fileAnchor = (path) => `f-${[...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;

// The line being commented on, or the range: on one side, inside one hunk.
function inComposer(item, file, side, num) {
  const c = S.fcomp;
  return c && c.item === item.id && c.path === file.path && c.subject === 'line' && !c.reply && c.side === side && num >= (c.startLine ?? c.line) && num <= c.line;
}

// The rows of one file's diff, and which threads found their line.
function diffTable(item, file, threads) {
  const split = diffMode() === 'split';
  const cols = split ? 4 : 3;
  const placed = new Set();
  const at = new Map();
  for (const t of threads) if (t.subject === 'line' && t.line !== null && !t.isOutdated) at.set(`${t.side}:${t.line}`, [...(at.get(`${t.side}:${t.line}`) ?? []), t]);
  const data = S.files[item.id].data;
  const c = S.fcomp;
  // Under a line: its threads, then the composer when it ends there.
  const under = (side, num) => {
    if (num === undefined) return '';
    const list = at.get(`${side}:${num}`) ?? [];
    for (const t of list) placed.add(t);
    const comp = c && c.item === item.id && c.path === file.path && c.subject === 'line' && !c.reply && c.side === side && c.line === num ? composerHTML(item, file) : '';
    return list.map((t) => diffThreadHTML(item, t, data)).join('') + comp;
  };
  const sel = (side, num) => inComposer(item, file, side, num);
  const content = S.fcontent[contentKey(item.id, file.path)];
  const lines = content?.lines;
  const shown = S.fexp[item.id]?.[file.path] ?? {};
  const hunks = hunksOf(file);
  let rows = '';
  // Lines shown around the hunks can't be commented: GitHub takes only lines of the diff.
  const ctxRow = (o, n) => lineRow({ t: 'eq', o, n, text: lines[n - 1] ?? '' }, under, null, sel);
  const more = (key, label) => `<tr class="fgap"><td colspan="${cols}"><button data-fmore="${esc(file.path)}|${key}"${content?.loading ? ' disabled' : ''}>↕ ${content?.loading ? 'Leyendo…' : label}</button>${content?.error ? ` <span class="bad">${esc(content.error)}</span>` : ''}</td></tr>`;
  let prevNew = 0;
  hunks.forEach((h, k) => {
    const gap = h.newStart - 1 - prevNew;
    if (gap > 0) {
      const open = lines ? Math.min(shown[k] ?? 0, gap) : 0;
      if (gap - open > 0) rows += more(k, `Mostrar ${Math.min(MORE_LINES, gap - open)} líneas más (${gap - open} sin cambios)`);
      for (let n = h.newStart - open; n < h.newStart; n++) rows += ctxRow(n + h.oldStart - h.newStart, n);
    }
    rows += `<tr class="fhunk"><td colspan="${cols}">@@ −${h.oldStart} +${h.newStart} @@ ${esc(h.ctx)}</td></tr>`;
    rows += split ? splitRows(h.lines, under, k, sel) : h.lines.map((l) => lineRow(l, under, k, sel)).join('');
    prevNew = h.newEnd;
  });
  // After the last hunk: how much is left is known once the file is read.
  const last = hunks[hunks.length - 1];
  if (last && file.status !== 'added') {
    const tail = lines ? lines.length - prevNew : null;
    const open = lines ? Math.min(shown.end ?? 0, tail) : 0;
    for (let n = prevNew + 1; n <= prevNew + open; n++) rows += ctxRow(n + last.oldEnd - last.newEnd, n);
    if (tail === null) rows += more('end', 'Mostrar más líneas');
    else if (tail - open > 0) rows += more('end', `Mostrar ${Math.min(MORE_LINES, tail - open)} líneas más (${tail - open} hasta el final)`);
  }
  const colgroup = split ? '<colgroup><col class="cn"><col><col class="cn"><col></colgroup>' : '<colgroup><col class="cn"><col class="cn"><col></colgroup>';
  return { html: `<table class="fdiff${split ? ' split' : ''}">${colgroup}<tbody>${rows}</tbody></table>`, placed };
}

const MARK = { add: '+', del: '−', eq: ' ' };
// A line number that opens the composer: its side and number, and its hunk
// (a range can't go past it).
const numCell = (cls, side, num, hunk) => (num === undefined ? `<td class="n ${cls}"></td>` : hunk === null ? `<td class="n ${cls}">${num}</td>` : `<td class="n ${cls} fl" data-fl="${side}|${num}|${hunk}" title="Comentar esta línea (Shift+clic: hasta acá)">${num}</td>`);
function lineRow(l, under, hunk, sel) {
  const side = l.t === 'del' ? 'LEFT' : 'RIGHT';
  const num = side === 'LEFT' ? l.o : l.n;
  const threads = under(side, num);
  return `<tr class="ln ${l.t}${sel(side, num) ? ' sel' : ''}">${numCell('', 'LEFT', l.o, hunk)}${numCell('', 'RIGHT', l.n, hunk)}<td class="c"><span class="m">${MARK[l.t]}</span>${esc(l.text)}</td></tr>${threads ? `<tr class="fthreads"><td colspan="3">${threads}</td></tr>` : ''}`;
}
// Side by side: a run of deletions next to the additions that replace it.
function splitRows(lines, under, hunk, sel) {
  let out = '';
  for (let i = 0; i < lines.length;) {
    if (lines[i].t === 'eq') {
      out += pairRow(lines[i], lines[i], under, hunk, sel);
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].t === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out += pairRow(dels[k], adds[k], under, hunk, sel);
  }
  return out;
}
function pairRow(left, right, under, hunk, sel) {
  const cell = (l, side, num) => (l ? `${numCell(`${l.t}${sel(side, num) ? ' sel' : ''}`, side, num, hunk)}<td class="c ${l.t}${sel(side, num) ? ' sel' : ''}"><span class="m">${MARK[l.t]}</span>${esc(l.text)}</td>` : '<td class="n none"></td><td class="c none"></td>');
  const threads = (left && left.t === 'del' ? under('LEFT', left.o) : '') + (right ? under('RIGHT', right.n) : '');
  return `<tr class="ln">${cell(left, 'LEFT', left?.o)}${cell(right, 'RIGHT', right?.n)}</tr>${threads ? `<tr class="fthreads"><td colspan="4">${threads}</td></tr>` : ''}`;
}

function diffThreadHTML(item, t, data) {
  const key = `t:${t.url}`;
  // Resolved threads start folded, like on GitHub.
  const open = t.isResolved ? S.expanded.has(key) : !S.expanded.has(key);
  const where = t.subject === 'file' ? 'Sobre el archivo' : t.isOutdated || t.line === null ? `Línea ${t.originalLine ?? '?'}, en código que ya cambió` : `${t.startLine && t.startLine !== t.line ? `Líneas ${t.startLine}–${t.line}` : `Línea ${t.line}`}${t.side === 'LEFT' ? ', versión anterior' : ''}`;
  const chips = (t.isResolved ? '<span class="chip ok">resuelto</span>' : '') + (t.isOutdated ? '<span class="chip idle">desactualizado</span>' : '');
  const comments = t.comments.map((c) => `<div class="tc">${avatar(c.author)}<div><header><b>${esc(c.author || 'alguien')}</b>${c.author === data.ronin ? '<span class="botl">bot</span>' : ''}<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(when(c.createdAt))}</a></header><div class="md">${md(c.body, item.repo)}</div></div></div>`).join('');
  // What the person's review adds: only they see it until they send it.
  const me = S.snap?.me ?? '';
  const editing = S.fcomp?.item === item.id ? S.fcomp.edit : null;
  const pending = (t.pending ?? []).map((c) => (editing === c.nodeId
    ? composerHTML(item, null)
    : `<div class="tc pend" id="p-${esc(c.nodeId)}">${avatar(me)}<div><header><b>${esc(me)}</b><span class="pendl">Pendiente</span><span class="pact"><button data-fpedit="${esc(c.nodeId)}">Editar</button><button data-fpdel="${esc(c.nodeId)}"${S.fbusy.has(c.nodeId) ? ' disabled' : ''}>Borrar</button></span></header><div class="md">${md(c.body, item.repo)}</div></div></div>`)).join('');
  const replying = S.fcomp?.item === item.id && S.fcomp.reply === t.id;
  const busy = S.fbusy.has(t.id);
  // A thread the review starts takes no replies or resolving until it's sent.
  const foot = replying
    ? composerHTML(item, null)
    : t.mine ? '' : `<div class="tfoot"><button class="treply" data-freply="${esc(t.id)}">Responder…</button><button class="btn-s" data-fresolve="${esc(t.id)}" data-on="${t.isResolved ? '0' : '1'}"${busy ? ' disabled' : ''}>${busy ? '…' : t.isResolved ? 'Reabrir' : 'Resolver conversación'}</button></div>`;
  const count = t.comments.length + (t.pending?.length ?? 0);
  return `<details class="dthread${t.mine ? ' mine' : ''}" data-thread="${esc(key)}"${open || replying || t.pending ? ' open' : ''}><summary><span>${esc(where)}</span>${chips}${t.pending ? `<span class="pendl">${t.mine ? 'en tu revisión' : `${t.pending.length} en tu revisión`}</span>` : ''}<span class="n">${count} ${count === 1 ? 'comentario' : 'comentarios'}</span></summary>${comments}${pending}${foot}</details>`;
}

// The lines a comment is on, as the new file has them: what a suggestion replaces.
function linesForSuggestion(file, c) {
  const out = [];
  for (const h of hunksOf(file)) for (const l of h.lines) if (l.n !== undefined && l.n >= (c.startLine ?? c.line) && l.n <= c.line) out.push(l.text);
  return out;
}

function composerHTML(item, file) {
  const c = S.fcomp;
  const where = c.reply || c.edit ? '' : c.subject === 'file' ? 'el archivo entero' : c.startLine ? `líneas ${c.startLine}–${c.line}${c.side === 'LEFT' ? ' (versión anterior)' : ''}` : `línea ${c.line}${c.side === 'LEFT' ? ' (versión anterior)' : ''}`;
  const canSuggest = !c.reply && !c.edit && c.subject === 'line' && c.side === 'RIGHT' && file;
  const body = c.preview
    ? `<div class="dpv md">${c.text.trim() ? md(c.text, item.repo) : '<p class="m">Nada para mostrar.</p>'}</div>`
    : `<textarea id="fcbox" rows="4" placeholder="${c.reply ? 'Respuesta' : 'Comentario'} (markdown). Ctrl+Enter ${c.edit ? 'lo guarda' : reviewOf(c.item) ? 'lo suma a tu revisión' : 'empieza una revisión'}.">${esc(c.text)}</textarea>`;
  // As in GitHub: once a review is started, what's written goes into it.
  const send = (mode, label, primary) => `<button class="btn-s${primary ? ' primary' : ''}" data-fcsend="${mode}"${c.sending ? ' disabled' : ''}>${c.sending === mode ? 'Enviando…' : label}</button>`;
  const buttons = c.edit
    ? send('edit', 'Guardar', true)
    : reviewOf(c.item)
      ? send('review', 'Sumar a la revisión', true)
      : send('now', c.reply ? 'Responder ya' : 'Comentar ya', false) + send('review', 'Empezar una revisión', true);
  return `<div class="dcomp"><div class="dct"><button class="dtb" data-fcpv="0" aria-selected="${!c.preview}">Escribir</button><button class="dtb" data-fcpv="1" aria-selected="${!!c.preview}">Vista previa</button>${canSuggest ? '<button class="dtool" data-fsuggest title="Proponer el código que va en esas líneas">± Sugerir cambio</button>' : ''}<span class="where">${esc(where)}</span></div>
    ${body}
    <div class="dfoot">${c.error ? `<span class="bad">${esc(c.error)}</span>` : `<span class="m">${c.reply ? '' : c.subject === 'line' ? 'Shift+clic en otro número para elegir varias líneas. ' : ''}Comentás como ${esc(S.snap?.me ?? '')}.</span>`}<button class="btn-s" data-fccancel>Cancelar</button>${buttons}</div></div>`;
}

async function loadFiles(id) {
  const entry = (S.files[id] ??= {});
  if (entry.loading) return;
  entry.loading = true;
  try {
    // What the person marked as viewed and their pending review are theirs, read with their token; without them the diff still shows.
    const [data, mine] = await Promise.all([api(`/api/items/${encodeURIComponent(id)}/files`), api(`/api/items/${encodeURIComponent(id)}/files/mine`).catch((error) => (error instanceof Unauthorized ? Promise.reject(error) : null))]);
    entry.data = data;
    if (mine) {
      entry.viewed = new Set(mine.viewed);
      entry.review = mine.review;
    }
    entry.error = null;
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  // A new head: the files read before are another version.
  for (const key of Object.keys(S.fcontent)) if (key.startsWith(`${id}|`) && S.fcontent[key].sha && S.fcontent[key].sha !== entry.data?.headSha) delete S.fcontent[key];
  if (S.sel === id) renderCenter();
}

// "Show more lines": the file at the PR's head is read the first time, then
// each click opens MORE_LINES more.
async function showMoreLines(id, path, key) {
  const exp = ((S.fexp[id] ??= {})[path] ??= {});
  const ck = contentKey(id, path);
  const content = (S.fcontent[ck] ??= {});
  exp[key] = (exp[key] ?? 0) + MORE_LINES;
  if (content.lines || content.loading) return renderCenter();
  content.loading = true;
  content.error = null;
  renderCenter();
  try {
    const got = await api(`/api/items/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`);
    content.sha = got.sha;
    content.lines = got.text.split('\n');
    if (content.lines[content.lines.length - 1] === '') content.lines.pop();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    content.error = error.message;
    exp[key] -= MORE_LINES;
  } finally {
    content.loading = false;
  }
  if (S.sel === id) renderCenter();
}

async function filesAction(id, body) {
  return api(`/api/items/${encodeURIComponent(id)}/files/actions`, { method: 'POST', body: JSON.stringify(body) });
}

// After writing on GitHub: the files and the item's comments are read again.
function afterFilesWrite(id) {
  if (S.files[id]) S.files[id].at = 0;
  loadFiles(id);
  loadDetail(id);
}

// `mode`: now (out at once), review (into the person's pending review, started if needed), edit (a pending one).
async function sendComment(mode) {
  const c = S.fcomp;
  if (!c || c.sending) return;
  mode ??= c.edit ? 'edit' : 'review';
  const box = $('#fcbox');
  if (box) c.text = box.value;
  if (!c.text.trim()) {
    c.error = 'Escribí algo primero.';
    return renderCenter();
  }
  const data = S.files[c.item]?.data;
  const review = mode === 'review' ? { review: true } : {};
  const body = c.edit
    ? { action: 'pending-edit', commentId: c.edit, text: c.text }
    : c.reply
      ? { action: 'reply', commentId: c.commentId, text: c.text, ...review }
      : { action: 'comment', path: c.path, commitId: data.headSha, subject: c.subject, text: c.text, ...review, ...(c.subject === 'line' ? { side: c.side, line: c.line, ...(c.startLine ? { startLine: c.startLine } : {}) } : {}) };
  const started = mode === 'review' && !reviewOf(c.item);
  c.sending = mode;
  c.error = null;
  renderCenter();
  try {
    const posted = await filesAction(c.item, body);
    S.fcomp = null;
    if (mode === 'now') toast(c.reply ? 'Respondiste en el hilo.' : 'Comentaste en el PR.', posted?.url);
    else toast(mode === 'edit' ? 'Guardado en tu revisión.' : started ? 'Empezaste una revisión: nadie la ve hasta que la mandes.' : 'Sumado a tu revisión.');
    afterFilesWrite(c.item);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    c.sending = false;
    c.error = `No se pudo: ${error.message}`;
    renderCenter();
  }
}

async function deletePending(nodeId) {
  const id = S.sel;
  S.fbusy.add(nodeId);
  renderCenter();
  try {
    await filesAction(id, { action: 'pending-delete', commentId: nodeId });
    toast('Borrado de tu revisión.');
    afterFilesWrite(id);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo: ${error.message}`);
  } finally {
    S.fbusy.delete(nodeId);
    renderCenter();
  }
}

// ---------- the review panel (#111)
// Finishing the review as in GitHub's "Review changes": a summary, Comment,
// Approve or Request changes, and the pending comments it carries.
const REVIEW_EVENTS = [
  ['COMMENT', 'Comentar', '', 'Sin aprobar ni bloquear: solo deja los comentarios.'],
  ['APPROVE', 'Aprobar', 'ok', 'El PR queda aprobado.'],
  ['REQUEST_CHANGES', 'Pedir cambios', 'crit', 'El PR no se puede mergear hasta que lo apruebes o se descarte tu revisión.'],
];
const isMine = (login) => (login ?? '').toLowerCase() === (S.snap?.me ?? '').toLowerCase();
// A PR's page offers the review, and so does an issue's, for its moving PR
// (the one in its Archivos tab); an exploration PR has its own approval (#93).
const reviewable = (item, d) => (item.kind === 'pr' || item.kind === 'issue') && !d?.exploration && d?.pr?.state === 'OPEN';
// On an issue, the button says which PR it reviews.
const reviewLabel = (item, d) => (item.kind === 'issue' ? `Revisar PR #${d.pr.number}` : 'Revisar');

function openReviewPanel() {
  const id = S.sel;
  if (!id) return;
  S.rpanel = S.rpanel?.item === id ? null : { item: id, event: 'COMMENT', text: '', fix: true, sending: false, error: null };
  if (S.rpanel && !S.files[id]?.data) loadFiles(id);
  renderCenter();
  if (S.rpanel) $('#rsum')?.focus();
}

function reviewPanelHTML(item) {
  const p = S.rpanel;
  if (!p || p.item !== item.id) return '';
  const entry = S.files[item.id];
  const data = entry?.data;
  const d = S.detail[item.id]?.data;
  const head = `<header><h2>Terminar la revisión</h2><span class="m">${data ? `de PR #${esc(data.pr)}, ` : ''}como ${esc(S.snap?.me ?? '')}</span><button class="x" data-rclose aria-label="Cerrar">×</button></header>`;
  if (!data) return `<div class="rpanel" role="dialog" aria-label="Terminar la revisión">${head}<div class="rbody"><p class="m">${entry?.error ? `No se pudo leer el PR: ${esc(entry.error)}` : 'Leyendo el PR…'}</p></div></div>`;
  const own = isMine(data.author);
  const event = own ? 'COMMENT' : p.event;
  const pend = pendingOf(item.id);
  const ronins = d?.ronin && data.author.toLowerCase() === d.ronin.toLowerCase();
  const autoMerge = d?.pr?.labels?.includes('ronin:auto-merge');
  const options = REVIEW_EVENTS.map(([value, label, cls, help]) => {
    const off = own && value !== 'COMMENT';
    const why = value === 'APPROVE' && autoMerge ? 'El PR tiene ronin:auto-merge: se mergea cuando pasen los checks.' : help;
    return `<label class="${off ? 'off' : ''}"${off ? ' title="GitHub no deja aprobar ni pedir cambios en tu propio PR"' : ''}><input type="radio" name="rev" value="${value}"${event === value ? ' checked' : ''}${off ? ' disabled' : ''}><b class="${cls}">${label}</b><small>${esc(off ? 'No se puede en tu propio PR.' : why)}</small></label>`;
  }).join('');
  // ronin reads a review's comments, not its summary, and acts on them only when asked.
  const fixable = ronins && (pend.length > 0 || event === 'REQUEST_CHANGES');
  const fix = fixable ? `<label class="rfix"><input type="checkbox" id="rfix"${p.fix ? ' checked' : ''}><span><b>Que ronin los atienda ahora</b><small>Después de la revisión comenta <code>@${esc(d.ronin)} /fix-comments</code> a tu nombre.</small></span></label>` : '';
  const where = (t) => `${t.path.split('/').pop()}${t.subject === 'file' ? '' : t.line ? ` · línea ${t.line}` : ''}`;
  const list = pend.length
    ? pend.map(({ t, c }) => `<button class="ri" data-rjump="${esc(t.path)}|${esc(c.nodeId)}"><span class="w">${esc(where(t))}${t.isNew ? '' : ' · respuesta'}</span><span class="t">${esc(c.body.replace(/```suggestion[\s\S]*?```/g, '[cambio sugerido]').trim().split('\n')[0])}</span></button>`).join('')
    : '<p class="m">Ningún comentario todavía: hacé clic en el número de una línea en Archivos.</p>';
  const can = !p.sending && (event !== 'COMMENT' || pend.length > 0 || p.text.trim());
  return `<div class="rpanel" role="dialog" aria-label="Terminar la revisión">${head}<div class="rbody">
    <textarea id="rsum" rows="3" placeholder="Resumen (opcional). Va arriba de la revisión, como en GitHub.">${esc(p.text)}</textarea>
    <div class="rev">${options}</div>${fix}
    <div class="rlist"><div class="rh">En tu revisión<span>${pend.length ? `${pend.length} comentario${pend.length === 1 ? '' : 's'}` : ''}</span></div>${list}</div></div>
    <footer>${p.error ? `<span class="bad">${esc(p.error)}</span>` : `<span class="m">${pend.length ? 'Hasta mandarla, nadie ve tus comentarios.' : ''}</span>`}${reviewOf(item.id) ? `<button class="btn-s danger" data-rdiscard${p.sending ? ' disabled' : ''}>Descartar</button>` : ''}<button class="btn-s primary" data-rsend${can ? '' : ' disabled'}>${p.sending ? 'Enviando…' : 'Mandar revisión'}</button></footer></div>`;
}

function wireReviewPanel() {
  const p = S.rpanel;
  if (!p) return;
  for (const button of document.querySelectorAll('[data-rclose]')) button.onclick = () => { S.rpanel = null; renderCenter(); };
  const sum = $('#rsum');
  if (sum) {
    sum.oninput = () => {
      p.text = sum.value;
      const send = $('[data-rsend]');
      if (send && !p.sending) send.disabled = !((p.event !== 'COMMENT' && !isMine(S.files[p.item]?.data?.author)) || pendingOf(p.item).length > 0 || p.text.trim());
    };
    sum.onkeydown = (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendReview(); };
  }
  for (const radio of document.querySelectorAll('input[name="rev"]')) radio.onchange = () => { p.event = radio.value; renderCenter(); };
  const fix = $('#rfix');
  if (fix) fix.onchange = () => { p.fix = fix.checked; };
  for (const button of document.querySelectorAll('[data-rsend]')) button.onclick = sendReview;
  for (const button of document.querySelectorAll('[data-rdiscard]')) button.onclick = discardPendingReview;
  for (const button of document.querySelectorAll('[data-rjump]')) {
    button.onclick = () => {
      const [path, nodeId] = button.dataset.rjump.split('|');
      S.rpanel = null;
      S.doc[S.sel] = 'files';
      goFile(path);
      document.getElementById(`p-${nodeId}`)?.scrollIntoView({ block: 'center' });
    };
  }
}

const REVIEW_SENT = { COMMENT: 'Mandaste tu revisión', APPROVE: 'Aprobaste el PR', REQUEST_CHANGES: 'Pediste cambios' };
async function sendReview() {
  const p = S.rpanel;
  const data = p && S.files[p.item]?.data;
  if (!p || !data || p.sending) return;
  const event = isMine(data.author) ? 'COMMENT' : p.event;
  const d = S.detail[p.item]?.data;
  const fixable = d?.ronin && data.author.toLowerCase() === d.ronin.toLowerCase() && (pendingOf(p.item).length > 0 || event === 'REQUEST_CHANGES');
  p.sending = true;
  p.error = null;
  renderCenter();
  try {
    const sent = await filesAction(p.item, { action: 'submit', event, text: p.text, commitId: data.headSha, fixComments: Boolean(fixable && p.fix) });
    S.rpanel = null;
    toast(`${REVIEW_SENT[event]}${sent.fixUrl ? '; ronin ya tiene el /fix-comments' : ''}.`, sent.url);
    afterFilesWrite(p.item);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    p.sending = false;
    p.error = `No se pudo: ${error.message}`;
    renderCenter();
  }
}

async function discardPendingReview() {
  const p = S.rpanel;
  const n = pendingOf(p.item).length;
  if (!confirm(`¿Descartar tu revisión${n ? ` con ${n} comentario${n === 1 ? '' : 's'}` : ''}? No se puede deshacer.`)) return;
  p.sending = true;
  renderCenter();
  try {
    await filesAction(p.item, { action: 'discard' });
    S.rpanel = null;
    toast('Descartaste tu revisión.');
    afterFilesWrite(p.item);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    p.sending = false;
    p.error = `No se pudo: ${error.message}`;
    renderCenter();
  }
}

async function resolveThread(threadId, resolved) {
  const id = S.sel;
  S.fbusy.add(threadId);
  renderCenter();
  try {
    await filesAction(id, { action: 'resolve', threadId, resolved });
    toast(resolved ? 'Conversación resuelta.' : 'Conversación reabierta.');
    afterFilesWrite(id);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo: ${error.message}`);
  } finally {
    S.fbusy.delete(threadId);
    renderCenter();
  }
}

// "Viewed" shows at once and is undone if GitHub says no.
async function setViewed(path, viewed) {
  const id = S.sel;
  const entry = S.files[id];
  if (!entry?.data) return;
  entry.viewed ??= new Set();
  if (viewed) entry.viewed.add(path);
  else entry.viewed.delete(path);
  delete foldOf(id)[path];
  renderCenter();
  try {
    await filesAction(id, { action: 'viewed', path, viewed });
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    if (viewed) entry.viewed.delete(path);
    else entry.viewed.add(path);
    toast(`No se pudo marcar como visto: ${error.message}`);
    renderCenter();
  }
}

// v: the file in view goes viewed (or back), and the next one not viewed comes up.
function toggleViewedCurrent() {
  const files = S.files[S.sel]?.data?.files;
  if (!files?.length) return;
  const cur = S.fcur[S.sel] ?? files[0].path;
  const now = !viewedOf(S.sel).has(cur);
  setViewed(cur, now);
  const next = now && files.find((f) => !viewedOf(S.sel).has(f.path));
  if (next) goFile(next.path);
}

function openComposer(spot) {
  const prev = S.fcomp;
  // Re-opening on the same spot keeps what was written.
  const text = prev && prev.item === spot.item && !prev.sending && !prev.edit ? $('#fcbox')?.value ?? prev.text : '';
  S.fcomp = { text, preview: false, ...spot };
  renderCenter();
  focusComposer();
}
function focusComposer() {
  const box = $('#fcbox');
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

function goFile(path) {
  S.fcur[S.sel] = path;
  S.ftree = false;
  const item = itemById(S.sel);
  const file = S.files[S.sel]?.data?.files.find((f) => f.path === path);
  if (item && file && isFolded(item.id, file) && !viewedOf(item.id).has(path)) foldOf(item.id)[path] = false;
  renderCenter();
  document.getElementById(fileAnchor(path))?.scrollIntoView({ block: 'start' });
}

function moveFile(delta) {
  const files = S.files[S.sel]?.data?.files;
  if (!files?.length) return;
  const i = files.findIndex((f) => f.path === (S.fcur[S.sel] ?? files[0].path));
  goFile(files[Math.max(0, Math.min(files.length - 1, i + delta))].path);
}

function wireFiles() {
  for (const button of document.querySelectorAll('[data-fgo]')) button.onclick = () => goFile(button.dataset.fgo);
  for (const button of document.querySelectorAll('[data-ffold]')) {
    button.onclick = () => {
      const item = itemById(S.sel);
      const file = S.files[S.sel]?.data?.files.find((f) => f.path === button.dataset.ffold);
      if (item && file) foldOf(item.id)[file.path] = !isFolded(item.id, file);
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-fmore]')) {
    button.onclick = () => {
      const cut = button.dataset.fmore.lastIndexOf('|');
      showMoreLines(S.sel, button.dataset.fmore.slice(0, cut), button.dataset.fmore.slice(cut + 1));
    };
  }
  for (const button of document.querySelectorAll('[data-fmode]')) {
    button.onclick = () => {
      S.diffMode = button.dataset.fmode;
      try { localStorage.setItem('ronin-diff-mode', S.diffMode); } catch { /* sin storage */ }
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-ftree]')) {
    button.onclick = () => {
      S.ftree = !S.ftree;
      renderCenter();
    };
  }
  // A line number: comment it; with Shift, from the line already chosen to this one (same side, same hunk).
  for (const cell of document.querySelectorAll('[data-fl]')) {
    cell.onclick = (event) => {
      const [side, num, hunk] = cell.dataset.fl.split('|');
      const path = cell.closest('[data-file]').dataset.file;
      const line = Number(num);
      const c = S.fcomp;
      if (event.shiftKey && c && c.item === S.sel && c.path === path && c.subject === 'line' && !c.reply && c.side === side && c.hunk === hunk) {
        const from = Math.min(c.anchor, line);
        const to = Math.max(c.anchor, line);
        openComposer({ item: S.sel, path, subject: 'line', side, hunk, anchor: c.anchor, line: to, ...(from !== to ? { startLine: from } : {}) });
        return;
      }
      openComposer({ item: S.sel, path, subject: 'line', side, hunk, anchor: line, line });
    };
  }
  for (const button of document.querySelectorAll('[data-fcfile]')) button.onclick = () => openComposer({ item: S.sel, path: button.dataset.fcfile, subject: 'file' });
  for (const button of document.querySelectorAll('[data-freply]')) {
    button.onclick = () => {
      const t = S.files[S.sel]?.data?.threads.find((x) => x.id === button.dataset.freply);
      // A reply goes to the thread's last comment, as GitHub's reply box does.
      if (t) openComposer({ item: S.sel, path: t.path, reply: t.id, commentId: t.comments[t.comments.length - 1].id });
    };
  }
  for (const button of document.querySelectorAll('[data-fresolve]')) button.onclick = () => resolveThread(button.dataset.fresolve, button.dataset.on === '1');
  for (const box of document.querySelectorAll('[data-fviewed]')) box.onchange = () => setViewed(box.dataset.fviewed, box.checked);
  const fcbox = $('#fcbox');
  if (fcbox) {
    fcbox.oninput = () => { if (S.fcomp) S.fcomp.text = fcbox.value; };
    fcbox.onkeydown = (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendComment();
      if (event.key === 'Escape') {
        event.stopPropagation();
        S.fcomp = null;
        renderCenter();
      }
    };
  }
  for (const button of document.querySelectorAll('[data-fcpv]')) {
    button.onclick = () => {
      S.fcomp.preview = button.dataset.fcpv === '1';
      renderCenter();
      if (!S.fcomp.preview) focusComposer();
    };
  }
  for (const button of document.querySelectorAll('[data-fsuggest]')) {
    button.onclick = () => {
      const c = S.fcomp;
      const file = S.files[S.sel]?.data?.files.find((f) => f.path === c.path);
      if (!file) return;
      c.text = `${c.text.trim() ? `${c.text.replace(/\s+$/, '')}\n\n` : ''}\`\`\`suggestion\n${linesForSuggestion(file, c).join('\n')}\n\`\`\`\n`;
      c.preview = false;
      renderCenter();
      focusComposer();
    };
  }
  for (const button of document.querySelectorAll('[data-fccancel]')) {
    button.onclick = () => {
      S.fcomp = null;
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-fcsend]')) button.onclick = () => sendComment(button.dataset.fcsend);
  for (const button of document.querySelectorAll('[data-fpedit]')) {
    button.onclick = () => {
      const found = pendingOf(S.sel).find((x) => x.c.nodeId === button.dataset.fpedit);
      if (found) openComposer({ item: S.sel, path: found.t.path, edit: found.c.nodeId, text: found.c.body });
    };
  }
  for (const button of document.querySelectorAll('[data-fpdel]')) button.onclick = () => deletePending(button.dataset.fpdel);
  for (const button of document.querySelectorAll('[data-frev]')) button.onclick = (event) => {
    event.stopPropagation();
    openReviewPanel();
  };
  wireReviewPanel();
  const q = $('#fq');
  if (q) q.oninput = () => {
    S.fq[S.sel] = q.value;
    const at = q.selectionStart;
    renderCenter();
    const fresh = $('#fq');
    fresh.focus();
    fresh.setSelectionRange(at, at);
  };
  // The file in view is the one marked in the tree.
  const diffs = $('#fdiffs');
  if (diffs) diffs.onscroll = () => {
    const top = diffs.getBoundingClientRect().top + 48;
    let cur = null;
    for (const card of diffs.querySelectorAll('.fcard')) if (card.getBoundingClientRect().top <= top) cur = card.dataset.file;
    if (!cur || cur === S.fcur[S.sel]) return;
    S.fcur[S.sel] = cur;
    for (const row of document.querySelectorAll('[data-fgo]')) row.setAttribute('aria-current', String(row.dataset.fgo === cur));
  };
}

// ---------- reviewing an exploration PR (#93)
// The findings the PR brings, read into their parts, with their threads:
// a list on the left, the finding on the right (one after the other on a
// phone). Deciding on one is a comment on its file, written as whoever is
// logged in — what they'd write in "Files changed" — and ronin applies it
// as it does any other.
const RONIN_MENTION = /@ronin-agent\b/i;
const fichaKey = (f) => `${f.app}/${f.id}`;
const FICHA_GROUPS = [['decidir', 'Por decidir'], ['esperando', 'Esperando a ronin'], ['respondida', 'Respondidas por ronin'], ['lista', 'Listas para aprobar'], ['aprobada', 'Aprobadas'], ['rechazada', 'Rechazadas']];
const FICHA_DOT = { decidir: 'pending', esperando: 'live', respondida: 'run', lista: 'ok', aprobada: 'ok', rechazada: 'crit' };

// "Aprobar" on a finding leaves nothing on GitHub yet: it's this browser's
// mark of what was looked at and stays, so the review's progress shows. The
// finding is approved for real when the PR is (approveAndMerge).
const listasKey = (id) => `ronin-listas:${id}`;
function listas(id) {
  if (!S.listas[id]) {
    try { S.listas[id] = new Set(JSON.parse(localStorage.getItem(listasKey(id)) ?? '[]')); } catch { S.listas[id] = new Set(); }
  }
  return S.listas[id];
}
function setLista(id, key, on) {
  const set = listas(id);
  if (on) set.add(key);
  else set.delete(key);
  try { localStorage.setItem(listasKey(id), JSON.stringify([...set])); } catch { /* sin storage */ }
}

// Where a finding stands: decided in its file, or by its thread — ronin
// answers a first comment, or a reply that mentions it.
function fichaStatus(f, ronin, id) {
  if (f.estado === 'rechazado') return 'rechazada';
  if (f.estado === 'aprobado') return 'aprobada';
  const last = f.comments[f.comments.length - 1];
  if (!last) return id && listas(id).has(fichaKey(f)) ? 'lista' : 'decidir';
  if (last.author === ronin) return 'respondida';
  return !last.replyTo || RONIN_MENTION.test(last.body) ? 'esperando' : 'respondida';
}

function visibleFichas(data, id) {
  const { tipo, vp } = S.fichaFilter;
  const shown = data.fichas.filter((f) => (tipo === 'todas' || f.tipo === tipo) && (vp === 'todos' || f.viewport === vp));
  return FICHA_GROUPS.flatMap(([k]) => shown.filter((f) => fichaStatus(f, data.ronin, id) === k));
}

function currentFicha(item, data) {
  const list = visibleFichas(data, item.id);
  return list.find((f) => fichaKey(f) === S.ficha[item.id]) ?? data.fichas.find((f) => fichaKey(f) === S.ficha[item.id]) ?? list[0];
}

const sevClass = (f) => (f.tipo === 'idea' ? 'pulido' : f.gravedad);
const sevLabel = (f) => (f.tipo === 'idea' ? 'idea' : f.gravedad);
const VP_ICON = {
  mobile: '<svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><rect x=".75" y=".75" width="8.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  desktop: '<svg width="13" height="11" viewBox="0 0 13 11" aria-hidden="true"><rect x=".75" y=".75" width="11.5" height="7.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 10.25h5" stroke="currentColor" stroke-width="1.3"/></svg>',
};
const TALK_ICON = '<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><path d="M1 1.5h9v6H4.5L2 9.8V7.5H1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const vp = (v) => `<span class="vp">${VP_ICON[v] ?? ''}${esc(v)}</span>`;

function fichasHTML(item) {
  const entry = S.expl[item.id];
  const data = entry?.data;
  if (!data) return `<div class="doc" id="doc"><div class="empty">${entry?.error ? `No se pudieron leer las fichas: ${esc(entry.error)}` : 'Leyendo las fichas…'}</div></div>`;
  if (!data.fichas.length) return `<div class="doc" id="doc"><div class="empty"><b>Este PR no trae fichas nuevas</b>${data.error ? esc(data.error) : 'Solo cambia el inventario o el registro de corridas.'}</div></div>`;
  const f = currentFicha(item, data);
  const filter = (key, value, label) => `<button class="fchip" data-ffilter="${key}:${value}" aria-pressed="${S.fichaFilter[key] === value}">${label}</button>`;
  const shown = visibleFichas(data, item.id);
  const reviewed = data.fichas.filter((x) => fichaStatus(x, data.ronin, item.id) !== 'decidir').length;
  const groups = FICHA_GROUPS.map(([k, label]) => {
    const rows = shown.filter((x) => fichaStatus(x, data.ronin, item.id) === k);
    if (!rows.length) return '';
    return `<div class="fgrp"><span>${label}</span><span>${rows.length}</span></div>` + rows.map((x) => `<button class="frow${k === 'rechazada' ? ' rej' : ''}" data-ficha="${esc(fichaKey(x))}" aria-current="${f && fichaKey(x) === fichaKey(f)}">
      ${dotClass(FICHA_DOT[k])}<span class="tl">${esc(x.titulo)}</span>
      <span class="sub"><span class="id">${esc(x.id)}</span><span class="sev ${esc(sevClass(x))}">${esc(sevLabel(x))}</span>${vp(x.viewport)}${x.comments.length ? `<span class="vp">${TALK_ICON}${x.comments.length}</span>` : ''}</span></button>`).join('');
  }).join('');
  const progress = `<div class="fprog"><span class="fprog-bar"><i style="width:${(reviewed / data.fichas.length) * 100}%"></i></span>Revisadas ${reviewed} de ${data.fichas.length}</div>`;
  const list = `<div class="flist">${progress}<div class="filters">${filter('tipo', 'todas', 'Todas')}${filter('tipo', 'hallazgo', 'Hallazgos')}${filter('tipo', 'idea', 'Ideas')}<span class="gap"></span>${filter('vp', 'todos', 'Todos')}${filter('vp', 'desktop', 'Desktop')}${filter('vp', 'mobile', 'Mobile')}</div>
    <div class="frows" id="frows">${groups || '<p class="none">Ninguna ficha con esos filtros.</p>'}</div>
    ${data.runs.length ? `<div class="fruns">Corridas: ${data.runs.map((run) => `<a href="${esc(run.url)}" target="_blank" rel="noopener">${esc(run.id)}</a>`).join(', ')}</div>` : ''}</div>`;
  return `<div class="doc review${S.fichaOpen[item.id] ? ' open' : ''}" id="doc" data-key="${esc(`${item.id}:fichas`)}">${list}<div class="fdetail" id="fdetail" data-current="${esc(f ? fichaKey(f) : '')}">${f ? fichaHTML(item, data, f, shown) : ''}</div></div>`;
}

function shotHTML(img, label, which, extra = '') {
  const local = evidenceSrc(img.url);
  const pic = local
    ? `<button class="img" data-zoom="${which}"><img class="ev" src="${esc(local)}" alt="${esc(img.nota ?? label)}" data-label="${esc(`[imagen${img.nota ? `: ${img.nota}` : ''}]`)}"></button>`
    : `<a class="img" href="${esc(img.url)}" target="_blank" rel="noopener noreferrer">[imagen${img.nota ? `: ${esc(img.nota)}` : ''}]</a>`;
  return `<figure class="shot ${which === 'despues' ? 'after' : ''}"><div class="lab"><b>${label}</b>${extra}</div>${pic}${img.nota ? `<figcaption>${esc(img.nota)}</figcaption>` : ''}</figure>`;
}

function compareHTML(f) {
  const key = fichaKey(f);
  const i = Math.min(S.antes[key] ?? 0, Math.max(0, f.antes.length - 1));
  const old = S.oldAfter.has(key) && f.despuesAnterior;
  const after = f.despues && (old ? f.despuesAnterior : f.despues);
  const thumbs = f.antes.length > 1 ? `<span class="thumbs">${f.antes.map((a, k) => {
    const local = evidenceSrc(a.url);
    return `<button class="thumb" data-antes="${k}" aria-pressed="${k === i}" title="${esc(a.nota ?? `Antes ${k + 1}`)}">${local ? `<img class="ev" src="${esc(local)}" alt="" data-label="${k + 1}">` : k + 1}</button>`;
  }).join('')}</span>` : '';
  const before = f.antes[i];
  if (!before && !after) return '';
  const afterExtra = f.despuesAnterior ? `<button class="link tag" data-oldafter>${old ? 'ver la actual' : 'ver la anterior'}</button>` : '';
  const cls = [f.viewport === 'desktop' ? 'wide' : '', before && after ? '' : 'one'].filter(Boolean).join(' ');
  return `<div class="compare"><div class="ctop"><h3>Antes y después</h3>${thumbs}</div>
    <div class="pair ${cls}">${before ? shotHTML(before, 'Antes', 'antes', f.antes.length > 1 ? `<span>${i + 1} de ${f.antes.length}</span>` : '') : ''}${after ? shotHTML(after, 'Después', 'despues', `${old ? '<span>versión anterior</span>' : ''}${afterExtra}`) : ''}</div>
    ${after ? '' : '<p class="nodesp">Sin captura del después: ronin consideró que la propuesta se entiende sin ella.</p>'}</div>`;
}

function diffHTML(patch) {
  return `<pre class="diff">${patch.split('\n').map((l) => `<span class="${l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'd' : ''}">${esc(l) || ' '}</span>`).join('')}</pre>`;
}
function diffStat(patch) {
  const lines = patch.split('\n');
  const files = lines.filter((l) => l.startsWith('diff --git')).length;
  return `+${lines.filter((l) => /^\+(?!\+\+)/.test(l)).length} −${lines.filter((l) => /^-(?!--)/.test(l)).length}${files ? ` · ${files} ${files === 1 ? 'archivo' : 'archivos'}` : ''}`;
}

function fichaThreadHTML(item, data, f) {
  const roots = f.comments.filter((c) => !c.replyTo || !f.comments.some((o) => o.id === c.replyTo));
  const ordered = roots.flatMap((root) => [root, ...f.comments.filter((c) => c.replyTo === root.id)]);
  const files = prUrl(item.repo, item.number);
  const cms = ordered.map((c) => `<article class="cm${c.author === data.ronin ? ' bot' : ''}${c.replyTo ? ' reply' : ''}"><header>${avatar(c.author)}<b>${esc(c.author)}</b>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(when(c.createdAt))}</a>` : `<span>${esc(when(c.createdAt))}</span>`}</header><div class="md">${md(c.body, item.repo)}</div></article>`).join('');
  return `<div class="fthread"><h3>Conversación <span class="m">${f.comments.length ? `${f.comments.length} ${f.comments.length === 1 ? 'comentario' : 'comentarios'} en la ficha` : 'nadie comentó esta ficha'}</span></h3>
    ${cms ? `<div class="cms">${cms}</div>` : ''}
    <div class="composer"><textarea id="fcomment" rows="3" maxlength="4000" placeholder="Comentar en la ficha… ronin lo lee como en GitHub: puede rechazarla, corregirla, abrir un issue o responder.">${esc(S.fdraft[fichaKey(f)] ?? '')}</textarea>
      <div class="cf"><span>Comentás como ${esc(S.snap?.me ?? '')} sobre el archivo de la ficha${files ? `, en <a href="${esc(files)}/files" target="_blank" rel="noopener">“Files changed”</a>` : ''}.</span><button class="btn-s" id="fcomment-send">Comentar</button></div></div></div>`;
}

function decisionsHTML(f, status) {
  if (status === 'rechazada' || status === 'aprobada') return '';
  const marked = status === 'lista';
  const menu = S.fmenu ? `<div class="menu fmenu" role="menu">
    <button role="menuitem" data-fact="issue"><b>Pedir un issue aparte</b><small>Algo que surge de esta ficha pero no es su propuesta.</small></button>
    <button role="menuitem" data-fact="pregunta"><b>Preguntarle a ronin</b><small>Responde en el hilo, sin tocar la ficha.</small></button></div>` : '';
  return `<span class="decide">${status === 'decidir' || marked ? `<button class="btn-s ok" data-flista aria-pressed="${marked}" title="${marked ? 'Se aprueba cuando apruebes el PR. Clic para deshacer.' : 'Queda para aprobar: se aprueba cuando apruebes el PR.'}">${marked ? '✓ Para aprobar' : '✓ Aprobar'} <kbd>a</kbd></button>` : ''}
    <button class="btn-s" data-fact="cambios">Pedir cambios <kbd>c</kbd></button>
    <button class="btn-s danger" data-fact="rechazar">Rechazar <kbd>r</kbd></button>
    <span class="actions"><button class="btn-s" id="fmore" aria-haspopup="menu" aria-expanded="${S.fmenu}">Más ▾</button>${menu}</span></span>`;
}

function fichaHTML(item, data, f, shown) {
  const status = fichaStatus(f, data.ronin, item.id);
  const idx = shown.findIndex((x) => fichaKey(x) === fichaKey(f));
  const banner = {
    rechazada: `<div class="banner crit">${dotClass('crit')}<div><b>Rechazada</b>${f.motivo ? `<p>${esc(f.motivo)}</p>` : ''}</div></div>`,
    aprobada: `<div class="banner ok">${dotClass('ok')}<div><b>Aprobada</b>${f.issue ? `<p>Issue <a href="${esc(`https://github.com/${item.repo}/issues/${f.issue}`)}" target="_blank" rel="noopener">#${esc(f.issue)}</a>.</p>` : ''}</div></div>`,
    esperando: `<div class="banner run">${dotClass('live')}<div><b>Esperando a ronin</b><p>Hay un comentario que ronin todavía no respondió. Cuando lo aplique, su respuesta aparece abajo.</p></div></div>`,
  }[status] ?? '';
  const meta = [f.senal && f.senal !== f.gravedad && f.tipo !== 'idea' ? esc(f.senal) : '', `rol ${esc(f.rol)}`, esc(f.functionName || f.funcion), f.entorno ? 'entorno de dev' : ''].filter(Boolean).map((m) => `<span>${m}</span>`).join('');
  return `<div class="fwrap">
    <div class="fnav"><button class="pill fback" data-fback>← Fichas</button>${decisionsHTML(f, status)}<span class="m">${idx >= 0 ? `${idx + 1} de ${shown.length}` : ''}</span><button class="pill" data-fmove="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Ficha anterior">↑</button><button class="pill" data-fmove="1" ${idx < 0 || idx >= shown.length - 1 ? 'disabled' : ''} aria-label="Ficha siguiente">↓</button></div>
    <div class="fmeta"><span class="id">${esc(f.id)}</span><span class="sev ${esc(sevClass(f))}">${esc(sevLabel(f))}</span>${vp(f.viewport)}${meta}<a class="link fgh" href="${esc(f.url)}" target="_blank" rel="noopener">archivo ↗</a></div>
    <h2 class="ftitle">${esc(f.titulo)}</h2>
    ${banner}
    ${f.observado || f.esperado ? `<div class="obs">${f.observado ? `<div><h3>Qué pasa</h3><div class="md">${md(f.observado, item.repo)}</div></div>` : ''}${f.esperado ? `<div class="exp"><h3>Qué se esperaba</h3><div class="md">${md(f.esperado, item.repo)}</div></div>` : ''}</div>` : ''}
    ${compareHTML(f)}
    <div class="prop"><h3>Propuesta</h3><div class="md">${md(f.propuesta, item.repo)}</div></div>
    ${f.pasos.length ? `<details class="sec"><summary><h3>Cómo reproducirlo</h3><span class="m">${f.pasos.length} ${f.pasos.length === 1 ? 'paso' : 'pasos'}</span></summary><ol class="in">${f.pasos.map((p) => `<li>${esc(p)}</li>`).join('')}</ol></details>` : ''}
    ${f.evidencia.length ? `<details class="sec"><summary><h3>Evidencia</h3><span class="m">${esc([...new Set(f.evidencia.map((e) => e.tipo))].join(', '))}</span></summary><div class="in">${f.evidencia.map((e) => `<div class="ev-row"><span class="k">${esc(e.tipo)}</span><span class="v">${esc(e.detalle)}</span></div>`).join('')}</div></details>` : ''}
    ${f.parche ? `<details class="sec"><summary><h3>Cambio borrador del después</h3><span class="m">${esc(diffStat(f.parche))}</span></summary><div class="in">${diffHTML(f.parche)}</div></details>` : ''}
    ${fichaThreadHTML(item, data, f)}</div>`;
}

function selectFicha(key) {
  S.ficha[S.sel] = key;
  S.fichaOpen[S.sel] = true;
  const url = `/i/${encodeURIComponent(S.sel)}?f=${encodeURIComponent(key)}`;
  if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  renderCenter();
  const fd = $('#fdetail');
  if (fd) fd.scrollTop = 0;
  if (isMobile()) scrollTo(0, 0);
  document.querySelector(`.frow[aria-current="true"]`)?.scrollIntoView({ block: 'nearest' });
}

function moveFicha(delta) {
  const item = S.sel && itemById(S.sel);
  const data = item && S.expl[item.id]?.data;
  if (!data?.fichas.length) return;
  const list = visibleFichas(data, item.id);
  const cur = currentFicha(item, data);
  const i = list.findIndex((f) => cur && fichaKey(f) === fichaKey(cur));
  const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
  if (next) selectFicha(fichaKey(next));
}

// The finding's screenshots in large: the before shown next to the after; ←/→ go through the befores.
function renderLightbox() {
  let box = $('#lightbox');
  const lb = S.lightbox;
  const item = lb && itemById(lb.item);
  const f = item && S.expl[item.id]?.data?.fichas.find((x) => fichaKey(x) === lb.ficha);
  if (!f) {
    box?.remove();
    S.lightbox = null;
    return;
  }
  if (!box) box = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'lightbox', className: 'lightbox' });
  const key = fichaKey(f);
  const after = f.despues && (S.oldAfter.has(key) && f.despuesAnterior ? f.despuesAnterior : f.despues);
  const before = f.antes[lb.antes];
  const shots = lb.only === 'despues' || !before ? [['Después', after]] : [[`Antes${f.antes.length > 1 ? ` ${lb.antes + 1} de ${f.antes.length}` : ''}`, before], ...(after ? [['Después', after]] : [])];
  box.innerHTML = `<div class="lt"><b>${esc(f.id)}</b><span class="m">${esc(f.titulo)}</span>${f.antes.length > 1 ? '<span class="m keys"><kbd>←</kbd> <kbd>→</kbd> otra captura del antes</span>' : ''}<button id="lb-x">Cerrar ✕</button></div>
    <div class="lb">${shots.filter(([, img]) => img && evidenceSrc(img.url)).map(([label, img]) => `<figure><div><img src="${esc(evidenceSrc(img.url))}" alt="${esc(img.nota ?? label)}"></div><figcaption><b>${esc(label)}</b>${img.nota ? ` · ${esc(img.nota)}` : ''}</figcaption></figure>`).join('')}</div>`;
  $('#lb-x').onclick = () => { S.lightbox = null; renderLightbox(); };
}

const FICHA_ACTIONS = {
  rechazar: { title: 'Rechazar', field: 'Motivo: queda en knowledge.md para que no se vuelva a proponer', btn: 'Rechazar', cls: 'danger', placeholder: 'Por qué no va', quick: ['Muy poco probable: es una app interna con pocos usuarios', 'Ya está cubierto', 'No es un problema para el equipo', 'Lo resolvemos con otra ficha'] },
  cambios: { title: 'Pedir cambios', field: 'Qué cambiar en la propuesta', btn: 'Pedir cambios', placeholder: 'Por ejemplo: que el aviso diga “No se encontró el producto o ya fue eliminado por otro usuario”', redo: true },
  issue: { title: 'Pedir un issue aparte', field: 'Qué tiene que tener el issue', btn: 'Pedir el issue', placeholder: 'Por ejemplo: revisar todos los toasts de error de catálogos' },
  pregunta: { title: 'Preguntarle a ronin', field: 'Tu pregunta', btn: 'Preguntar', placeholder: '¿Esto pasa también como Sales?' },
  // On the whole PR, not a finding.
  general: { pr: true, title: 'Comentario general', field: 'Sobre varias fichas a la vez, o lo que las próximas exploraciones no deben volver a proponer', btn: 'Comentar', placeholder: 'Por ejemplo: F-0017 y F-0018 no aplican, el listado de catálogos lo usa una sola persona' },
  approve: { pr: true, optional: true, title: 'Aprobar la exploración', field: 'Comentario de la review (opcional)', btn: 'Aprobar', placeholder: 'Por ejemplo: las de catálogos van primero' },
};

function openPrDialog(kind) {
  const item = S.sel && itemById(S.sel);
  if (!item || !FICHA_ACTIONS[kind]) return;
  S.menu = false;
  S.fmenu = false;
  S.fdialog = { item: item.id, pr: item.number, action: kind, text: '', redo: false, sending: false, error: null };
  renderFichaDialog();
}

// What approving does, with what's left to look at: the findings that open
// an issue, the rejected ones, those nobody decided on and those ronin is
// still applying a comment on (approving waits for them).
function approveSummaryHTML(itemId) {
  const data = S.expl[itemId]?.data;
  if (!data) return '<p class="help">Leyendo las fichas…</p>';
  const status = (f) => fichaStatus(f, data.ronin, itemId);
  const li = (f) => `<li><span class="id">${esc(f.id)}</span><span class="t">${esc(f.titulo)}</span></li>`;
  const keep = data.fichas.filter((f) => f.estado !== 'rechazado');
  const rejected = data.fichas.filter((f) => f.estado === 'rechazado');
  const undecided = data.fichas.filter((f) => status(f) === 'decidir');
  const waiting = data.fichas.filter((f) => status(f) === 'esperando');
  return `<div class="sum"><p class="sumh">${dotClass('ok')}Abren su issue (${keep.length})</p>${keep.length ? `<ul>${keep.map(li).join('')}</ul>` : ''}
    <p class="sumh">${dotClass('crit')}Rechazadas, sin issue (${rejected.length})</p>${rejected.length ? `<ul>${rejected.map(li).join('')}</ul>` : ''}
    ${undecided.length ? `<p class="warnbox">${undecided.length === 1 ? 'Queda 1 ficha' : `Quedan ${undecided.length} fichas`} sin revisar (${esc(undecided.map((f) => f.id).join(', '))}). Si aprobás, también abren su issue.</p>` : ''}
    ${waiting.length ? `<p class="warnbox">ronin todavía está aplicando comentarios en ${esc(waiting.map((f) => f.id).join(', '))}. Aprobá cuando responda.</p>` : ''}
    <p class="help">Se envía como tu review <b>Approve</b> en GitHub. Con eso ronin marca las fichas, abre un issue por cada una que siga en pie y mergea el PR.</p></div>`;
}
const waitingCount = (itemId) => {
  const data = S.expl[itemId]?.data;
  return data ? data.fichas.filter((f) => fichaStatus(f, data.ronin, itemId) === 'esperando').length : 0;
};

// The comment as it will be written — the same words the server writes
// (dashboard-exploration-actions.ts's fichaComment).
function fichaCommentText(action, text, redo) {
  if (action === 'rechazar') return `Rechazo esta ficha: ${text}`;
  if (action === 'cambios') return redo ? `${text}\n\nTambién hay que rehacer la captura del después.` : text;
  if (action === 'issue') return `Abrí un issue aparte: ${text}`;
  return text;
}

function openFichaAction(action, opts = {}) {
  const item = S.sel && itemById(S.sel);
  const data = item && S.expl[item.id]?.data;
  const f = data && currentFicha(item, data);
  if (!f || !FICHA_ACTIONS[action]) return;
  S.fmenu = false;
  S.fdialog = { item: item.id, pr: item.number, ficha: fichaKey(f), fid: f.id, titulo: f.titulo, action, text: '', redo: Boolean(opts.redo), sending: false, error: null };
  renderCenter();
  renderFichaDialog();
}

function renderFichaDialog() {
  let layer = $('#flayer');
  const d = S.fdialog;
  if (!d) {
    layer?.remove();
    return;
  }
  const meta = FICHA_ACTIONS[d.action];
  if (!layer) {
    layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'flayer' });
    layer.innerHTML = `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="fdlg-t">
      <p class="help">${meta.pr ? `PR #${esc(d.pr)}` : `${esc(d.fid)} · ${esc(d.titulo)}`}</p>
      <h2 id="fdlg-t">${esc(meta.title)}</h2>
      ${d.action === 'approve' ? `<div id="fdlg-sum">${approveSummaryHTML(d.item)}</div>` : ''}
      <label class="field"><span>${esc(meta.field)}</span><textarea id="fdlg-text" rows="${meta.optional ? 2 : 4}" maxlength="4000" placeholder="${esc(meta.placeholder)}"></textarea></label>
      ${meta.quick ? `<div class="quick-r">${meta.quick.map((q) => `<button class="pill" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
      ${meta.redo ? `<label class="check"><input type="checkbox" id="fdlg-redo"${d.redo ? ' checked' : ''}><span>Rehacer la captura del después<small>ronin levanta la app con el cambio borrador corregido y reemplaza la imagen. Tarda unos minutos.</small></span></label>` : ''}
      ${d.action === 'approve' ? '' : `<div class="prev"><div class="lbl">${d.action === 'general' ? `Comentás como ${esc(S.snap?.me ?? '')} en el PR #${esc(d.pr)}` : `Comentás como ${esc(S.snap?.me ?? '')} en ${esc(d.fid)}, en “Files changed” del PR #${esc(d.pr)}`}</div><div class="md" id="fdlg-prev"></div></div>`}
      <p class="bad" id="fdlg-err" hidden></p>
      <div class="foot-d"><span class="kbd-hint"><kbd>Ctrl</kbd> <kbd>Enter</kbd> para enviar</span><button class="btn-s" id="fdlg-no">Cancelar</button><button class="btn-s ${meta.cls === 'danger' ? 'danger-solid' : 'primary'}" id="fdlg-yes"></button></div></div></div>`;
    const area = $('#fdlg-text');
    area.oninput = () => { S.fdialog.text = area.value; renderFichaDialog(); };
    area.onkeydown = (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendFichaAction(); };
    const redo = $('#fdlg-redo');
    if (redo) redo.onchange = () => { S.fdialog.redo = redo.checked; renderFichaDialog(); };
    for (const b of layer.querySelectorAll('[data-quick]')) b.onclick = () => { area.value = b.dataset.quick; S.fdialog.text = area.value; renderFichaDialog(); area.focus(); };
    $('#fdlg-no').onclick = closeFichaDialog;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeFichaDialog(); };
    $('#fdlg-yes').onclick = sendFichaAction;
    area.focus();
  }
  const typed = d.text.trim();
  const prev = $('#fdlg-prev');
  if (prev) prev.innerHTML = md(d.action === 'general' ? `@ronin-agent ${typed || '…'}` : fichaCommentText(d.action, typed || '…', d.redo), itemById(d.item)?.repo ?? '');
  const sum = $('#fdlg-sum');
  if (sum) {
    const html = approveSummaryHTML(d.item);
    if (sum._html !== html) sum.innerHTML = sum._html = html;
  }
  const yes = $('#fdlg-yes');
  yes.textContent = d.sending ? (d.action === 'approve' ? 'Aprobando…' : 'Comentando…') : meta.btn;
  yes.disabled = d.sending || (!meta.optional && !typed) || (d.action === 'approve' && waitingCount(d.item) > 0);
  $('#fdlg-err').hidden = !d.error;
  $('#fdlg-err').textContent = d.error ?? '';
}

function closeFichaDialog() {
  if (S.fdialog?.sending) return;
  S.fdialog = null;
  renderFichaDialog();
}

// Sends a comment on the finding (from the dialog, or the box under its
// thread) and reads the review again, so the finding shows it's waiting on ronin.
async function postFichaComment(itemId, ficha, action, text, redo) {
  const done = await api(`/api/items/${encodeURIComponent(itemId)}/exploration/actions`, { method: 'POST', body: JSON.stringify({ action, ficha, text, ...(redo ? { redo: true } : {}) }) });
  setLista(itemId, ficha, false);
  delete S.fdraft[ficha];
  toast(`Comentaste en ${ficha.split('/')[1]}. ronin lo va a aplicar y te responde en el hilo.`, done.url);
  if (S.expl[itemId]) S.expl[itemId].at = 0;
  await loadExploration(itemId);
}

// The general comment and the approval, on the whole PR.
async function postPrDecision(d) {
  const text = d.text.trim();
  const done = await api(`/api/items/${encodeURIComponent(d.item)}/exploration/${d.action}`, { method: 'POST', body: JSON.stringify(text ? { text } : {}) });
  toast(d.action === 'approve' ? `Aprobaste el PR #${d.pr}. ronin marca las fichas, abre sus issues y lo mergea.` : `Comentaste en el PR #${d.pr}. ronin lo va a aplicar y te responde ahí.`, done.url);
  if (S.detail[d.item]) S.detail[d.item].at = 0;
  if (S.expl[d.item]) S.expl[d.item].at = 0;
  await Promise.all([loadDetail(d.item), loadExploration(d.item)]);
}

async function sendFichaAction() {
  const d = S.fdialog;
  const meta = d && FICHA_ACTIONS[d.action];
  if (!d || d.sending || (!meta.optional && !d.text.trim())) return;
  d.sending = true;
  d.error = null;
  renderFichaDialog();
  try {
    if (meta.pr) await postPrDecision(d);
    else await postFichaComment(d.item, d.ficha, d.action, d.text.trim(), d.redo);
    S.fdialog = null;
    renderFichaDialog();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    d.sending = false;
    d.error = `No se pudo: ${error.message}`;
    renderFichaDialog();
  }
}

async function sendFreeComment() {
  const area = $('#fcomment');
  const key = $('#fdetail')?.dataset.current;
  const text = area?.value.trim();
  if (!text || !key) return area?.focus();
  const button = $('#fcomment-send');
  button.disabled = true;
  button.textContent = 'Comentando…';
  try {
    await postFichaComment(S.sel, key, 'comentar', text, false);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo comentar: ${error.message}`);
    button.disabled = false;
    button.textContent = 'Comentar';
  }
}

function toggleLista() {
  const item = S.sel && itemById(S.sel);
  const data = item && S.expl[item.id]?.data;
  const f = data && currentFicha(item, data);
  if (!f) return;
  const status = fichaStatus(f, data.ronin, item.id);
  if (status !== 'decidir' && status !== 'lista') return;
  setLista(item.id, fichaKey(f), status === 'decidir');
  if (status === 'decidir') {
    // On to the next one still to decide.
    const next = visibleFichas(data, item.id).find((x) => fichaStatus(x, data.ronin, item.id) === 'decidir');
    if (next) return selectFicha(fichaKey(next));
  }
  renderCenter();
}

async function loadExploration(id) {
  const entry = (S.expl[id] ??= {});
  if (entry.loading) return;
  entry.loading = true;
  try {
    entry.data = await api(`/api/items/${encodeURIComponent(id)}/exploration`);
    entry.error = null;
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  if (S.sel === id) renderCenter();
  if (S.fdialog?.item === id) renderFichaDialog();
}

// The item's conversation as GitHub shows it, oldest first: general
// comments, a PR's reviews (those that say something) and its review threads,
// each thread where its first comment falls.
function conversation(doc) {
  return [
    ...doc.comments.map((c) => ({ kind: 'comment', at: c.createdAt, c })),
    ...(doc.reviews ?? []).map((r) => ({ kind: 'review', at: r.submittedAt, r })),
    ...(doc.threads ?? []).map((t) => ({ kind: 'thread', at: t.comments[0].createdAt, t })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

const REVIEW_STATE = { APPROVED: ['ok', 'aprobó'], CHANGES_REQUESTED: ['crit', 'pidió cambios'], DISMISSED: ['idle', 'review descartada'], COMMENTED: ['idle', 'review'] };
// Past this, a body is shown cut, with "Ver todo" (ronin's external review summary runs long).
const CLIP_CHARS = 1800;

// What's opened (a resolved thread, a long review) stays open across redraws.
function clipped(key, html, long) {
  if (!long) return `<div class="md">${html}</div>`;
  const open = S.expanded.has(key);
  return `<div class="md${open ? '' : ' clip'}">${html}</div><button class="link more" data-expand="${esc(key)}">${open ? 'Ver menos' : 'Ver todo'}</button>`;
}

function entryHTML(e, d, own, repo) {
  const head = (author, url, at, extra = '') => `<header>${avatar(author)}<b>${esc(author || 'alguien')}</b>${extra}<a href="${esc(url)}" target="_blank" rel="noopener">${esc(when(at))}</a></header>`;
  const bot = (author) => (author === d.ronin ? ' bot' : '');
  if (e.kind === 'comment') return `<article class="cm${bot(e.c.author)}">${head(e.c.author, e.c.url, e.c.createdAt)}${clipped(`c:${e.c.url}`, md(e.c.body, repo), e.c.body.length > CLIP_CHARS)}</article>`;
  if (e.kind === 'review') {
    const [cls, label] = REVIEW_STATE[e.r.state] ?? REVIEW_STATE.COMMENTED;
    const key = `r:${e.r.author}:${e.r.submittedAt}`;
    return `<article class="cm${bot(e.r.author)}">${head(e.r.author, own.url, e.r.submittedAt, `<span class="chip ${cls}">${label}</span>`)}${e.r.body.trim() ? clipped(key, md(e.r.body, repo), e.r.body.length > CLIP_CHARS) : ''}</article>`;
  }
  const t = e.t;
  // The end of the path is what tells files apart: the last two parts, the whole one on hover.
  const parts = (t.path ?? 'archivo').split('/');
  const where = `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}${t.line ? `:${t.line}` : ''}`;
  const chips = (t.isResolved ? '<span class="chip ok">resuelto</span>' : '') + (t.isOutdated ? '<span class="chip idle">desactualizado</span>' : '');
  const key = `t:${t.url}`;
  // Resolved threads start folded, like on GitHub.
  const open = t.isResolved ? S.expanded.has(key) : !S.expanded.has(key);
  const replies = t.comments.map((c, i) => `<div class="tc${i ? ' reply' : ''}">${head(c.author, c.url, c.createdAt)}<div class="md">${md(c.body, repo)}</div></div>`).join('');
  return `<details class="cm thread${bot(t.comments[0].author)}" data-thread="${esc(key)}"${open ? ' open' : ''}><summary><span class="path" title="${esc(t.path ?? '')}">${esc(where)}</span>${chips}<span class="n">${t.comments.length} ${t.comments.length === 1 ? 'comentario' : 'comentarios'}</span><span class="who">${esc(t.comments[0].author)}</span></summary>${replies}</details>`;
}

const avatar = (login) => (/^[\w-]+$/.test(login ?? '') ? `<img class="av" src="https://avatars.githubusercontent.com/${login}?s=40" alt="">` : '<span class="av"></span>');
const when = (iso) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function wireCenter() {
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => select(button.dataset.tab);
  for (const button of document.querySelectorAll('[data-goped]')) button.onclick = () => openPedido(Number(button.dataset.goped));
  for (const button of document.querySelectorAll('[data-close]')) {
    button.onclick = () => {
      const id = button.dataset.close;
      S.open = S.open.filter((x) => x !== id);
      if (S.sel === id) {
        if (S.open[0]) select(S.open[0]);
        else {
          S.sel = null;
          stopStream();
          history.pushState(null, '', '/');
          renderAll();
        }
      } else renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-run]')) {
    button.onclick = () => {
      S.runIdx[S.sel] = Number(button.dataset.run);
      loadShownRun();
    };
  }
  for (const button of document.querySelectorAll('[data-runview]')) {
    button.onclick = () => {
      S.view[S.sel] = 'tx';
      S.runIdx[S.sel] = Number(button.dataset.runview);
      loadShownRun();
    };
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.onclick = () => {
      S.view[S.sel] = button.dataset.view;
      // The page follows the latest run, live if it's going.
      S.runIdx[S.sel] = 0;
      loadShownRun();
    };
  }
  for (const button of document.querySelectorAll('[data-doc]')) {
    button.onclick = () => {
      S.doc[S.sel] = button.dataset.doc;
      renderCenter();
    };
  }
  const act = $('#act');
  if (act) act.onclick = (event) => {
    event.stopPropagation();
    S.menu = !S.menu;
    renderCenter();
  };
  for (const button of document.querySelectorAll('[data-action]')) {
    button.onclick = (event) => {
      event.stopPropagation();
      openAction(button.dataset.action);
    };
  }
  for (const button of document.querySelectorAll('[data-ficha]')) button.onclick = () => selectFicha(button.dataset.ficha);
  wireFiles();
  for (const button of document.querySelectorAll('[data-fact]')) {
    button.onclick = (event) => {
      event.stopPropagation();
      openFichaAction(button.dataset.fact);
    };
  }
  for (const button of document.querySelectorAll('[data-flista]')) button.onclick = toggleLista;
  for (const button of document.querySelectorAll('[data-xpr]')) button.onclick = () => openPrDialog(button.dataset.xpr);
  const fmore = $('#fmore');
  if (fmore) fmore.onclick = (event) => {
    event.stopPropagation();
    S.fmenu = !S.fmenu;
    renderCenter();
  };
  const fcomment = $('#fcomment');
  if (fcomment) {
    fcomment.oninput = () => { S.fdraft[$('#fdetail').dataset.current] = fcomment.value; };
    fcomment.onkeydown = (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendFreeComment(); };
  }
  const fsend = $('#fcomment-send');
  if (fsend) fsend.onclick = sendFreeComment;
  for (const button of document.querySelectorAll('[data-fmove]')) button.onclick = () => moveFicha(Number(button.dataset.fmove));
  for (const button of document.querySelectorAll('[data-fback]')) button.onclick = () => { S.fichaOpen[S.sel] = false; renderCenter(); };
  for (const button of document.querySelectorAll('[data-ffilter]')) {
    button.onclick = () => {
      const [key, value] = button.dataset.ffilter.split(':');
      S.fichaFilter[key] = value;
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-antes]')) {
    button.onclick = () => {
      S.antes[S.ficha[S.sel] ?? $('#fdetail')?.dataset.current] = Number(button.dataset.antes);
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-oldafter]')) {
    button.onclick = () => {
      const key = $('#fdetail')?.dataset.current;
      if (S.oldAfter.has(key)) S.oldAfter.delete(key);
      else S.oldAfter.add(key);
      renderCenter();
    };
  }
  for (const button of document.querySelectorAll('[data-zoom]')) {
    button.onclick = () => {
      const key = $('#fdetail')?.dataset.current;
      S.lightbox = { item: S.sel, ficha: key, antes: S.antes[key] ?? 0, only: button.dataset.zoom === 'despues' ? 'despues' : null };
      renderLightbox();
    };
  }
  for (const button of document.querySelectorAll('[data-expand]')) {
    button.onclick = () => {
      const key = button.dataset.expand;
      if (S.expanded.has(key)) S.expanded.delete(key);
      else S.expanded.add(key);
      renderCenter();
    };
  }
  for (const thread of document.querySelectorAll('details[data-thread]')) {
    // A thread's default is open unless resolved; what's kept is the change from it.
    thread.ontoggle = () => {
      const key = thread.dataset.thread;
      const resolved = Boolean(thread.querySelector('.chip.ok'));
      if (thread.open === resolved) S.expanded.add(key);
      else S.expanded.delete(key);
      const center = $('#center');
      center._html = null;
    };
  }
  for (const link of document.querySelectorAll('a[data-ref]')) {
    if (!itemById(link.dataset.ref)) continue;
    link.onclick = (event) => {
      event.preventDefault();
      select(link.dataset.ref);
    };
  }
  const back = $('#back');
  if (back) back.onclick = () => {
    $('#shell').dataset.m = 'list';
    scrollTo(0, 0);
  };
}

// ---------- today
const tipEl = () => document.getElementById('tip') ?? Object.assign(document.body.appendChild(document.createElement('div')), { id: 'tip', className: 'tip', role: 'tooltip' });

// The day's numbers, each with its week as a sparkline (today last).
function sparkline(values) {
  const w = 120, h = 22;
  const vals = values.map((v) => v ?? 0);
  const max = Math.max(...vals, 1e-9);
  const pt = (v, k) => [(k / Math.max(1, vals.length - 1)) * w, h - 2 - (v / max) * (h - 4)];
  const d = vals.map((v, k) => `${k ? 'L' : 'M'}${pt(v, k).map((n) => n.toFixed(1)).join(',')}`).join('');
  const [lx, ly] = pt(vals[vals.length - 1], vals.length - 1);
  return `<svg width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="var(--run)"/></svg>`;
}

function tilesHTML(t) {
  const d = t.today;
  const week = t.week ?? [];
  const tile = (label, value, sub, series) => `<div class="tile"><div class="l">${label}</div><div class="v">${value}</div><div class="d">${sub}</div>${series.length > 1 ? sparkline(series) : ''}</div>`;
  return `<div class="tiles">
    ${tile('Corridas hoy', d.runs, `ayer <b>${t.yesterday.runs}</b>`, week.map((w) => w.runs))}
    ${tile('Terminaron bien', d.finished ? pct(d.ok / d.finished) : '—', d.finished ? `<b>${d.ok}</b> de ${d.finished} terminadas` : 'ninguna terminada todavía', week.map((w) => (w.finished ? w.ok / w.finished : null)))}
    ${tile('Duración mediana', d.medianMs !== null ? esc(duration(d.medianMs)) : '—', d.p90Ms !== null ? `p90 <b>${esc(duration(d.p90Ms))}</b>` : '&nbsp;', week.map((w) => w.medianMs))}
    ${tile('Costo hoy', d.costUsd ? esc(money(d.costUsd)) : 'US$0', [t.yesterday.costUsd !== undefined ? `ayer <b>${esc(t.yesterday.costUsd ? money(t.yesterday.costUsd) : 'US$0')}</b>` : null, d.failed ? `${d.failed} con error` : null, d.usageLimit ? `${d.usageLimit} sin cuota` : null].filter(Boolean).join(', ') || 'sin errores', week.map((w) => w.costUsd))}
  </div>`;
}

// What waits on a person, to act on: blocked issues, ronin's PRs waiting for
// a review or a merge (the longest waiting first), the exploration PR and
// the previews that are up.
function attention() {
  const items = S.snap.items;
  const blocked = items.filter((i) => i.status === 'blocked');
  const waitedSince = (i) => Date.parse(i.lastRun?.endedAt ?? i.lastRun?.startedAt ?? '') || Date.now();
  const review = items.filter((i) => i.kind === 'issue' && i.slices?.length && i.status === 'waiting' && i.pr && !i.pr.isDraft && i.pr.reviewDecision !== 'CHANGES_REQUESTED'
    && !i.pr.checks.some((c) => c.outcome !== 'passed')).sort((a, b) => waitedSince(a) - waitedSince(b));
  const exploration = items.filter((i) => i.kind === 'pr' && i.note === 'PR de exploración abierto');
  return { blocked, review, exploration, previews: S.snap.previews, waitedSince };
}

function attentionHTML(a) {
  const ref = (i) => [`#${i.number}`, i.linear?.id].filter(Boolean).join(' · ');
  const row = (cls, title, sub, when, id, icon = '') => `<button class="arow" ${id ? `data-att="${esc(id)}"` : ''}>${dotClass(cls)}<span class="t">${esc(title)}</span><span class="w">${esc(when)}</span><span class="s">${icon}${esc(sub)}</span></button>`;
  const total = a.blocked.length + a.review.length + a.exploration.length + a.previews.length;
  const shownReview = S.attAll ? a.review : a.review.slice(0, 4);
  return `<div class="card"><h2>Necesitan tu atención<span class="c">${total || 'nada'}</span></h2><div class="att">
    <div class="ag">Bloqueados, esperan una respuesta</div>
    ${a.blocked.length ? a.blocked.map((i) => row('crit', i.title, `${ref(i)} · ${i.block?.reason ?? 'el motivo está en el email del bloqueo'}`, i.block ? `hace ${short(Date.now() - Date.parse(i.block.at))}` : '', i.id, ghIcon('issue', i.github))).join('') : '<div class="none">Ninguno.</div>'}
    <div class="ag">PRs de ronin que esperan tu review o tu merge, el que más espera primero</div>
    ${a.review.length ? shownReview.map((i) => row(i.pr.reviewDecision === 'APPROVED' ? 'ok' : 'warn', i.title, `PR #${i.pr.number} · ${[i.linear?.id, i.pr.reviewDecision === 'APPROVED' ? 'aprobado, falta el merge' : i.pr.checks.length ? 'checks en verde' : 'sin checks'].filter(Boolean).join(' · ')}`, `hace ${short(Date.now() - a.waitedSince(i))}`, i.id, ghIcon('pr', 'open'))).join('') : '<div class="none">Ninguno.</div>'}
    ${a.review.length > 4 ? `<button class="more-l" id="att-more">${S.attAll ? 'Ver menos' : `Ver los ${a.review.length} →`}</button>` : ''}
    ${a.exploration.length || a.previews.length ? '<div class="ag">Exploración y previews</div>' : ''}
    ${a.exploration.map((i) => row('run', i.title, `PR #${i.number} · ${repoShort(i.repo)} · fichas para revisar`, i.lastRun ? `hace ${short(Date.now() - Date.parse(i.lastRun.endedAt ?? i.lastRun.startedAt))}` : '', i.id, ghIcon('pr', i.github))).join('')}
    ${a.previews.map((p) => {
      const left = p.expiresAt ? Date.parse(p.expiresAt) - Date.now() : null;
      const item = S.snap.items.find((i) => i.repo === p.repo && (i.number === p.prNumber || i.slices?.some((sl) => sl.prNumber === p.prNumber)));
      return row(p.preparing ? 'live' : 'ok', `Preview de #${p.prNumber} ${p.preparing ? 'preparando datos' : 'arriba'}`, `${p.appName} · ${repoShort(p.repo)}${left !== null ? ` · se baja en ${short(left)}` : ''}`, p.startedAt ? short(Date.now() - Date.parse(p.startedAt)) : '', item?.id);
    }).join('')}
  </div></div>`;
}

// The cycle's issues by where they stand: ronin's by what GitHub says of
// them, the team's by their Linear state (dashboard-linear.ts).
const BUCKETS = [
  ['done', 'hechos', 'var(--ok)'],
  ['ronin', 'ronin trabaja', 'var(--run)'],
  ['review', 'en review', 'var(--warn)'],
  ['blocked', 'esperan a alguien', 'var(--crit)'],
  ['started', 'en curso, del equipo', 'var(--lin)'],
  ['todo', 'sin empezar', 'var(--faint)'],
];
const endDay = (iso) => dayMonth(new Date(Date.parse(iso) - 1).toISOString());
const DAY_MS = 24 * 60 * MIN;

function niceMax(v) {
  const step = v <= 10 ? 2 : v <= 50 ? 10 : v <= 100 ? 20 : 50;
  return Math.max(step, Math.ceil(v / step) * step);
}

// Issues in the cycle against issues done, day by day (Linear's history),
// over the whole cycle so what's left to go shows as room.
const BURN = { W: 400, H: 180, l: 28, r: 96, t: 10, b: 20 };
function burnGeometry(c) {
  const total = Math.max(1, Math.round((Date.parse(c.endsAt) - Date.parse(c.startsAt)) / DAY_MS));
  const max = niceMax(Math.max(...c.scopeHistory, 1));
  const x = (d) => BURN.l + (d / total) * (BURN.W - BURN.l - BURN.r);
  const y = (v) => BURN.t + (1 - v / max) * (BURN.H - BURN.t - BURN.b);
  return { total, max, x, y };
}

function burnHTML(c, index) {
  const scope = c.scopeHistory;
  const done = c.doneHistory;
  if (!scope.length) return '';
  const { W, H } = BURN;
  const { total, max, x, y } = burnGeometry(c);
  const last = scope.length - 1;
  const line = (arr) => arr.map((v, d) => `${d ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line(done)}L${x(last).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`;
  const grid = [0, max / 2, max].map((v) => `<line x1="${BURN.l}" x2="${W - BURN.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--rule)"/><text x="${BURN.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`).join('');
  // Linear's history can lag a day or two behind: today gets its own mark.
  const now = Math.max(0, Math.min(total, (Date.now() - Date.parse(c.startsAt)) / DAY_MS));
  const labels = [[0, dayMonth(c.startsAt), 'start'], [total, endDay(c.endsAt), 'end']];
  if (x(now) - x(0) > 30 && x(total) - x(now) > 30) labels.push([now, 'hoy', 'middle']);
  const xlabels = labels.map(([d, text, anchor]) => `<text x="${x(d)}" y="${H - 4}" text-anchor="${anchor}">${esc(text)}</text>`).join('');
  // End labels, pulled apart when the two values are close.
  let ys = y(scope[last]) + 4;
  let yd = y(done[last] ?? 0) + 4;
  if (yd - ys < 13) {
    const mid = (ys + yd) / 2;
    ys = mid - 6.5;
    yd = mid + 6.5;
  }
  return `<div class="burn" data-burn="${index}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${cycleName(c)}: ${scope[last]} issues en el ciclo y ${done[last] ?? 0} hechos`)}">
      ${grid}${xlabels}
      <line x1="${x(now)}" x2="${x(now)}" y1="${BURN.t}" y2="${H - BURN.b}" stroke="var(--faint)" stroke-dasharray="3 3"/>
      <path d="${area}" fill="var(--ok)" opacity=".12"/>
      <path d="${line(scope)}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${line(done)}" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(last)}" cy="${y(scope[last])}" r="4" fill="var(--muted)" stroke="var(--panel)" stroke-width="2"/>
      <circle cx="${x(last)}" cy="${y(done[last] ?? 0)}" r="4" fill="var(--ok)" stroke="var(--panel)" stroke-width="2"/>
      <text class="end" x="${x(last) + 8}" y="${ys}">${scope[last]} en el ciclo</text>
      <text class="end" x="${x(last) + 8}" y="${yd}">${done[last] ?? 0} hechos</text>
      <line class="cross" x1="0" x2="0" y1="${BURN.t}" y2="${H - BURN.b}" stroke="var(--faint)" visibility="hidden"/>
      <rect class="hit" x="${BURN.l}" y="0" width="${W - BURN.l - BURN.r}" height="${H}" fill="transparent"/>
    </svg><div class="btip" hidden></div>
    <div class="lg"><span><i style="background:var(--muted)"></i>issues en el ciclo</span><span><i style="background:var(--ok)"></i>hechos</span></div></div>`;
}

function cycleHTML(c, index) {
  const left = Math.ceil((Date.parse(c.endsAt) - Date.now()) / DAY_MS);
  const counts = BUCKETS.map(([k, label, color]) => [k, label, color, c.issues.filter((i) => i.bucket === k).length]);
  const total = c.issues.length || 1;
  const stack = counts.filter(([, , , n]) => n).map(([, label, color, n]) => `<i style="width:${(n / total) * 100}%;background:${color}" title="${n} ${esc(label)}"></i>`).join('');
  const legend = counts.filter(([, , , n]) => n).map(([, label, color, n]) => `<span><i style="background:${color}"></i><b>${n}</b> ${esc(label)}</span>`).join('');
  return `<div class="card"><h2>${LIN_ICON} ${esc(cycleName(c))}${S.today.cycles.length > 1 ? ` · ${esc(repoShort(c.repo))}` : ''}<span class="c">${esc(dayMonth(c.startsAt))} – ${esc(endDay(c.endsAt))} · ${left > 1 ? `quedan ${left} días` : left === 1 ? 'termina mañana' : 'termina hoy'}</span></h2>
    <div class="stack">${stack}</div><div class="legend">${legend}</div>
    ${burnHTML(c, index)}</div>`;
}

function breakdownHTML(c) {
  const brow = (name, swatch, segs, n, attrs = '', tag = 'div') => `<${tag} class="brow" ${attrs}><span class="bn"><i style="background:${swatch}"></i><span>${esc(name)}</span></span><span class="bb">${segs}</span><span class="bc">${n}</span></${tag}>`;
  const groups = new Map();
  for (const issue of c.issues) {
    const key = issue.project?.id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const maxP = Math.max(...[...groups.values()].map((g) => g.length), 1);
  const projects = [...groups].sort((a, b) => (a[0] === '') - (b[0] === '') || b[1].length - a[1].length).map(([id, issues]) => {
    const segs = BUCKETS.map(([k, , color]) => {
      const n = issues.filter((i) => i.bucket === k).length;
      return n ? `<i style="width:${(n / maxP) * 100}%;background:${color}"></i>` : '';
    }).join('');
    return id
      ? brow(issues[0].project.name, projectColor(id), segs, issues.length, `data-proj="${esc(id)}" aria-pressed="${S.project === id}" title="Filtrar la lista por este proyecto"`, 'button')
      : brow('Sin proyecto', 'var(--proj-other)', segs, issues.length);
  }).join('');
  const open = c.issues.filter((i) => i.bucket !== 'done');
  const owners = new Map();
  for (const issue of open) owners.set(issue.owner, (owners.get(issue.owner) ?? 0) + 1);
  const people = [...owners].sort((a, b) => (b[0] === 'ronin') - (a[0] === 'ronin') || (a[0] === '') - (b[0] === '') || b[1] - a[1]);
  const maxO = Math.max(...people.map(([, n]) => n), 1);
  const who = people.map(([owner, n]) => {
    const color = owner === 'ronin' ? 'var(--hanko)' : 'var(--faint)';
    return brow(owner || 'sin asignar', color, `<i style="width:${(n / maxO) * 100}%;background:${color}"></i>`, n);
  }).join('');
  const ronin = owners.get('ronin') ?? 0;
  return `<div class="card">
    <div class="side-list"><h3>Por proyecto, en el ciclo</h3>${projects || '<p class="note">El ciclo no tiene issues.</p>'}</div>
    <div class="side-list"><h3>Quién tiene qué, de lo que falta</h3>${who || '<p class="note">Todo el ciclo está hecho.</p>'}${open.length ? `<p class="note">ronin tiene ${ronin} de los ${open.length} issues que faltan del ciclo.</p>` : ''}</div>
  </div>`;
}

function renderToday() {
  const t = S.today;
  const running = S.snap.items.filter((i) => i.status === 'running').length;
  const a = attention();
  const lead = [
    running ? `${running} ${running === 1 ? 'agente trabajando' : 'agentes trabajando'}` : 'ningún agente trabajando',
    a.blocked.length ? `${a.blocked.length} ${a.blocked.length === 1 ? 'issue espera' : 'issues esperan'} una respuesta` : null,
    a.review.length ? `${a.review.length} ${a.review.length === 1 ? 'PR espera' : 'PRs esperan'} tu review o tu merge` : null,
  ].filter(Boolean).join(', ');
  const date = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
  const head = `<h1>Hoy</h1><p class="lead">${esc(date[0].toUpperCase() + date.slice(1))} · ${esc(lead)}.</p>`;
  if (!t) return `<div class="today">${head}<div class="empty">Cargando…</div></div>`;

  const cycles = t.cycles ?? [];
  const right = cycles.map((c, i) => cycleHTML(c, i) + breakdownHTML(c)).join('');
  const grid = `<div class="hgrid ${right ? '' : 'one'}">${attentionHTML(a)}${right ? `<div class="rcol">${right}</div>` : ''}</div>`;

  const from = Date.parse(t.from);
  const to = Date.now();
  const span = to - from;
  const pos = (ms) => Math.max(0, Math.min(100, ((ms - from) / span) * 100));
  const lanes = S.snap.repos.map((repo) => {
    const rows = [];
    const bars = t.timeline.filter((run) => run.repo === repo).map((run) => {
      const start = pos(Date.parse(run.startedAt));
      const end = run.state === 'running' ? 100 : pos(Date.parse(run.endedAt ?? run.startedAt));
      let row = rows.findIndex((last) => last < start - 0.4);
      if (row < 0) row = rows.push(-1) - 1;
      rows[row] = Math.max(end, start + 0.4);
      const item = itemById(run.itemId);
      const [, , label] = STATE[run.state] ?? STATE.error;
      const when = `${hhmm(run.startedAt)}${run.endedAt ? `–${hhmm(run.endedAt)}` : ', en curso'}`;
      const tip = `${typeName(run.taskType)}${item ? `\n${item.title}` : ''}\n${when}, ${label}`;
      const cls = run.state === 'running' ? 'live' : ['error', 'timeout', 'cut'].includes(run.state) ? 'fail' : run.state === 'usage_limit' ? 'quota' : '';
      return `<button class="bar ${cls}" style="left:${start}%;width:max(6px,${end - start}%);top:${6 + row * 15}px;background-color:${repoColor(repo)}" data-item="${esc(run.itemId)}" data-run="${esc(run.runId)}" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"></button>`;
    }).join('');
    const height = Math.max(1, rows.length) * 15 + 10;
    return `<div class="lane"><span class="nm">${esc(repoShort(repo))}</span><div class="track" style="height:${height}px">${bars}<span class="nowl"></span></div></div>`;
  }).join('');
  const ticks = [0, 2, 4, 6, 8, 10, 12].map((h) => `<span class="${h % 4 === 2 ? 'minor' : ''}" style="left:${(h / 12) * 100}%">${h === 12 ? 'ahora' : esc(hhmm(new Date(from + h * 60 * MIN).toISOString()))}</span>`).join('');
  const legend = S.snap.repos.map((repo) => `<span><i style="background:${repoColor(repo)}"></i>${esc(repoShort(repo))}</span>`).join('') + '<span><i class="lg-fail"></i>terminó con error</span>';
  const timeline = `<div class="day"><h2>Últimas 12 horas<span class="legend">${legend}</span></h2>
    ${t.timeline.length ? '' : '<p class="note" style="margin:0 0 8px">Ninguna corrida de agentes en las últimas 12 horas.</p>'}
    ${lanes}<div class="axis"><span></span><div class="ticks">${ticks}</div></div></div>`;
  return `<div class="today">${head}${tilesHTML(t)}${grid}${timeline}</div>`;
}

function wireBurn(el) {
  const c = S.today?.cycles?.[Number(el.dataset.burn)];
  if (!c) return;
  const svg = el.querySelector('svg');
  const cross = el.querySelector('.cross');
  const tip = el.querySelector('.btip');
  const { x } = burnGeometry(c);
  const last = c.scopeHistory.length - 1;
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  el.querySelector('.hit').onpointermove = (e) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * BURN.W;
    let d = 0;
    for (let k = 0; k <= last; k++) if (Math.abs(x(k) - vx) < Math.abs(x(d) - vx)) d = k;
    if (vx > x(last) + 20) return hide();
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    cross.setAttribute('visibility', 'visible');
    const day = document.createElement('b');
    day.textContent = dayMonth(new Date(Date.parse(c.startsAt) + d * DAY_MS).toISOString());
    const lineOf = (color, text) => {
      const div = document.createElement('div');
      const key = Object.assign(document.createElement('span'), { className: 'k' });
      key.style.background = color;
      div.append(key, text);
      return div;
    };
    tip.replaceChildren(day, lineOf('var(--muted)', `${c.scopeHistory[d]} en el ciclo`), lineOf('var(--ok)', `${c.doneHistory[d] ?? 0} hechos`));
    tip.hidden = false;
    const px = (x(d) / BURN.W) * rect.width;
    tip.style.left = `${Math.min(px + 12, rect.width - tip.offsetWidth)}px`;
    tip.style.top = '8px';
  };
  el.querySelector('.hit').onpointerleave = hide;
}

function wireToday() {
  const tip = tipEl();
  const show = (bar, x, y) => {
    tip.textContent = bar.dataset.tip;
    tip.style.opacity = '1';
    tip.style.left = `${Math.min(x + 14, innerWidth - 300)}px`;
    tip.style.top = `${y + 14}px`;
  };
  const hide = () => { tip.style.opacity = '0'; };
  for (const bar of document.querySelectorAll('.bar[data-run]')) {
    bar.onpointermove = (e) => show(bar, e.clientX, e.clientY);
    bar.onpointerleave = hide;
    bar.onfocus = () => { const r = bar.getBoundingClientRect(); show(bar, r.left, r.bottom); };
    bar.onblur = hide;
    bar.onclick = () => {
      hide();
      S.pendingRun = bar.dataset.run;
      select(bar.dataset.item);
    };
  }
  for (const row of document.querySelectorAll('[data-att]')) row.onclick = () => select(row.dataset.att);
  const more = document.getElementById('att-more');
  if (more) more.onclick = () => {
    S.attAll = !S.attAll;
    renderAll();
  };
  for (const row of document.querySelectorAll('[data-proj]')) {
    row.onclick = () => {
      S.project = S.project === row.dataset.proj ? '' : row.dataset.proj;
      saveScope();
      renderAll();
    };
  }
  for (const el of document.querySelectorAll('[data-burn]')) wireBurn(el);
}

function goHome() {
  S.sel = null;
  S.page = null;
  stopStream();
  if (location.pathname !== '/') history.pushState(null, '', '/');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  refresh();
}

// ---------- request portal accounts (#114)
// The people who ask for small changes in the portal, without GitHub: only
// the dashboard's admins see this page.
function openPortal() {
  S.sel = null;
  S.page = 'portal';
  stopStream();
  if (location.pathname !== '/portal') history.pushState(null, '', '/portal');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadPortal();
}

async function loadPortal() {
  try {
    S.portal = { data: await api('/api/portal-admin'), error: null };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.portal = { ...S.portal, error: error.message };
  }
  renderQuick();
  renderCenter();
}

const appKey = (a) => `${a.repo}:${a.app}`;
const appLabel = (grant) => {
  const app = S.portal.data?.apps.find((a) => appKey(a) === appKey(grant));
  return app ? `${app.org} · ${app.name}` : `${grant.repo} · ${grant.app} (ya no está en el portal)`;
};

function portalStatus(u) {
  if (u.disabled) return ['idle', 'desactivada'];
  if (!u.hasPassword) return u.link && Date.parse(u.link.expiresAt) > Date.now() ? ['warn', 'invitada'] : ['crit', 'invitación vencida'];
  return ['ok', 'activa'];
}

function portalHTML() {
  const p = S.portal;
  const head = `<h1>Portal de pedidos</h1><p class="lead">Quienes piden ajustes chicos sin cuenta de GitHub. Entran con correo y contraseña${p.data?.url ? ` en <a href="${esc(p.data.url)}" target="_blank" rel="noopener">${esc(p.data.url.replace(/^https?:\/\//, ''))}</a>` : ''}.</p>${portalTabsHTML('usuarios')}`;
  if (p.error && !p.data) return `<div class="today">${head}<p class="bad">${esc(p.error)}</p></div>`;
  if (!p.data) return `<div class="today">${head}<div class="empty">Cargando…</div></div>`;
  const { users, apps } = p.data;
  const rows = users.map((u) => {
    const [cls, label] = portalStatus(u);
    return `<tr data-puser="${esc(u.id)}" tabindex="0"><td>${esc(u.name)}<small>${esc(u.email)}</small></td>
      <td class="hide-m">${u.grants.length ? u.grants.map((g) => `<span class="tag">${esc(appLabel(g))}</span>`).join('') : '<span class="m">ninguna</span>'}</td>
      <td class="hide-m">${u.lastLoginAt ? `hace ${esc(short(Date.now() - Date.parse(u.lastLoginAt)))}` : '<span class="m">nunca</span>'}</td>
      <td><span class="chip ${cls}">${label}</span></td></tr>`;
  }).join('');
  return `<div class="today padm">${head}
    <div class="padm-bar"><button class="btn-s primary" data-pnew ${apps.length ? '' : 'disabled'}>+ Invitar</button>
      ${apps.length ? `<span class="m">Apps del portal: ${apps.map((a) => esc(`${a.org} · ${a.name}`)).join(', ')}</span>` : '<span class="bad">Ningún repo tiene <code>portal.apps</code> en repos.json: no hay apps para habilitar.</span>'}</div>
    ${users.length ? `<table class="padm-t"><thead><tr><th>Persona</th><th class="hide-m">Puede pedir en</th><th class="hide-m">Último acceso</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="note">Todavía no hay cuentas.</p>'}
  </div>`;
}

function wirePortal() {
  $('#center').querySelector('[data-pnew]')?.addEventListener('click', () => openPortalUser(null));
  for (const row of $('#center').querySelectorAll('[data-puser]')) {
    row.onclick = () => openPortalUser(row.dataset.puser);
    row.onkeydown = (event) => { if (event.key === 'Enter') openPortalUser(row.dataset.puser); };
  }
}

function openPortalUser(id) {
  const u = id ? S.portal.data.users.find((x) => x.id === id) : null;
  S.pdialog = { id, email: u?.email ?? '', name: u?.name ?? '', grants: new Set((u?.grants ?? []).map(appKey)), dailyLimit: u?.dailyLimit ?? '', busy: false, error: null, done: null };
  renderPortalUser();
}

function closePortalUser() {
  if (S.pdialog?.busy) return;
  S.pdialog = null;
  renderPortalUser();
}

function renderPortalUser() {
  let layer = $('#player');
  const d = S.pdialog;
  if (!d) {
    layer?.remove();
    return;
  }
  const u = d.id ? S.portal.data.users.find((x) => x.id === d.id) : null;
  const apps = S.portal.data.apps;
  const byOrg = [...new Set(apps.map((a) => a.repo))].map((repo) => apps.filter((a) => a.repo === repo));
  const linkLabel = u && u.hasPassword ? 'Mandar enlace para nueva contraseña' : 'Volver a mandar la invitación';
  const fresh = !layer;
  layer ??= Object.assign(document.body.appendChild(document.createElement('div')), { id: 'player' });
  layer.innerHTML = `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="pu-t">
    <h2 id="pu-t">${u ? esc(u.name) : 'Invitar al portal'}</h2>
    <p class="help">${u ? `${esc(u.email)} · creada por ${esc(u.createdBy)}` : 'Le llega un correo con un enlace para crear su contraseña. Vence en 24 horas.'}</p>
    <label class="field"><span>Nombre</span><input id="pu-name" maxlength="120" autocomplete="off" value="${esc(d.name)}"></label>
    <label class="field"><span>Correo</span><input id="pu-email" type="email" autocomplete="off" value="${esc(d.email)}" ${u ? 'readonly' : ''}></label>
    <fieldset class="pu-apps"><legend>Puede pedir ajustes en</legend>
      ${byOrg.map((group) => `<div class="pu-org"><b>${esc(group[0].org)}</b> <span class="m">${esc(group[0].repo)}</span>
        ${group.map((a) => `<label class="check"><input type="checkbox" data-pgrant="${esc(appKey(a))}" ${d.grants.has(appKey(a)) ? 'checked' : ''}><span>${esc(a.name)}${a.description ? `<small>${esc(a.description)}</small>` : ''}</span></label>`).join('')}</div>`).join('')}
    </fieldset>
    <label class="field"><span>Pedidos por día</span><input id="pu-limit" type="number" min="0" max="100" placeholder="${esc(S.portal.data.dailyLimit)} (el de PORTAL_DAILY_LIMIT)" value="${esc(d.dailyLimit)}"></label>
    ${u ? `<div class="pu-more"><button class="btn-s" data-plink ${u.disabled || d.busy ? 'disabled' : ''}>${linkLabel}</button>
      <button class="btn-s ${u.disabled ? '' : 'danger'}" data-poff ${d.busy ? 'disabled' : ''}>${u.disabled ? 'Reactivar' : 'Desactivar'}</button></div>
      <p class="note">${u.disabled ? 'Desactivada: no puede entrar.' : 'Desactivar cierra sus sesiones al momento.'} Nadie más ve la contraseña: la crea la persona desde el enlace.</p>` : ''}
    ${d.done ? `<p class="${d.done.url ? 'bad' : 'note'}">${esc(d.done.text)}</p>${d.done.url ? `<input class="pu-link" readonly value="${esc(d.done.url)}" aria-label="Enlace">` : ''}` : ''}
    <p class="bad" ${d.error ? '' : 'hidden'}>${esc(d.error ?? '')}</p>
    <div class="foot-d"><button class="btn-s" data-pclose>${d.done ? 'Cerrar' : 'Cancelar'}</button><button class="btn-s primary" data-psave ${d.busy ? 'disabled' : ''}>${d.busy ? 'Guardando…' : u ? 'Guardar' : 'Crear e invitar'}</button></div>
  </div></div>`;
  $('#pu-name').oninput = (e) => { S.pdialog.name = e.target.value; };
  $('#pu-email').oninput = (e) => { S.pdialog.email = e.target.value; };
  $('#pu-limit').oninput = (e) => { S.pdialog.dailyLimit = e.target.value; };
  for (const box of layer.querySelectorAll('[data-pgrant]')) box.onchange = () => { if (box.checked) S.pdialog.grants.add(box.dataset.pgrant); else S.pdialog.grants.delete(box.dataset.pgrant); };
  layer.querySelector('[data-pclose]').onclick = closePortalUser;
  layer.querySelector('[data-psave]').onclick = savePortalUser;
  layer.querySelector('[data-plink]')?.addEventListener('click', () => portalWrite(`/api/portal-admin/users/${d.id}/link`, {}));
  layer.querySelector('[data-poff]')?.addEventListener('click', () => portalWrite(`/api/portal-admin/users/${d.id}`, { disabled: !u.disabled }));
  layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closePortalUser(); };
  layer.querySelector('.pu-link')?.select();
  if (fresh) $('#pu-name').focus();
}

function savePortalUser() {
  const d = S.pdialog;
  const grants = S.portal.data.apps.filter((a) => d.grants.has(appKey(a))).map((a) => ({ repo: a.repo, app: a.app }));
  const limit = String(d.dailyLimit).trim();
  const body = { name: d.name, grants, dailyLimit: limit === '' ? null : Number(limit) };
  if (d.id) portalWrite(`/api/portal-admin/users/${d.id}`, body);
  else portalWrite('/api/portal-admin/users', { ...body, email: d.email });
}

// A change to an account; the dialog stays open with what happened.
async function portalWrite(path, body) {
  const d = S.pdialog;
  d.busy = true;
  d.error = null;
  renderPortalUser();
  try {
    const out = await api(path, { method: 'POST', body: JSON.stringify(body) });
    const users = S.portal.data.users.filter((u) => u.id !== out.user.id);
    S.portal.data.users = [...users, out.user].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    d.id = out.user.id;
    d.email = out.user.email;
    if (out.sent === true) d.done = { text: `Listo: le mandamos el enlace a ${out.user.email}.` };
    else if (out.sent === false) d.done = { text: `La cuenta quedó, pero el correo no salió. Pásale este enlace por otro medio (vence en 24 horas):`, url: out.url };
    else d.done = { text: body.disabled === true ? 'Cuenta desactivada.' : body.disabled === false ? 'Cuenta reactivada.' : 'Guardado.' };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    d.error = error.message;
  }
  d.busy = false;
  renderPortalUser();
  renderQuick();
  renderCenter();
}

// ---------- the portal's requests (#132)
// What people ask through the portal and where each request stands, for
// anyone who sees its repo: its conversation, what ronin did with it and,
// once it has them, its issue and PR. The accounts are the Usuarios tab,
// for admins only.
const PED_STATUS = {
  thinking: ['run', 'ronin lo está leyendo'], asking: ['warn', 'Espera a la persona'], answered: ['idle', 'Respondido'],
  minor: ['run', 'Armando el prototipo'], proposed: ['warn', 'Espera que apruebe'], approved: ['run', 'Aprobado'],
  reproducing: ['run', 'Reproduciendo el error'], fixing: ['run', 'En corrección'],
  done: ['ok', 'Listo'], resolved: ['ok', 'Resuelto por el equipo'], declined: ['idle', 'No se hará'],
  cancelled: ['idle', 'Cancelado'], big: ['warn', 'En el equipo'],
};
const PED_CLOSED = ['done', 'resolved', 'declined', 'cancelled'];
const PED_FILTERS = [['todos', 'Todos'], ['person', 'Esperan a la persona'], ['ronin', 'ronin trabajando'], ['team', 'Esperan al equipo'], ['cerrados', 'Cerrados']];
const PED_TABS = [['act', 'Actividad'], ['repro', 'Reproducción'], ['chat', 'Conversación'], ['team', 'Para el equipo'], ['runs', 'Corridas']];
// A reported error's tries at reproducing it (#137), and how many it gets.
const PED_REPRODUCTIONS = 2;
const PED_ICON = {
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  ronin: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  run: '<svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  crit: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
};
const pedPath = (n, rest = '') => `/api/pedidos/${n}${rest}`;
const pedImg = (n, file) => pedPath(n, `/img/${encodeURIComponent(file)}`);
const firstName = (name) => String(name ?? '').split(' ')[0];
const issueUrl = (repo, number) => (safeRepo(repo) ? `https://github.com/${repo}/issues/${number}` : null);
const ago = (iso) => (iso ? `hace ${short(Date.now() - Date.parse(iso))}` : '');

function waitsLabel(p) {
  const who = firstName(p.person);
  switch (p.waitsOn) {
    case 'person': return p.status === 'proposed' ? `${who}: aprobar o ajustar` : `${who}: responder`;
    case 'ronin': return p.running ? 'ronin trabajando' : p.status === 'approved' && p.issue ? `ronin: el cambio en #${p.issue}` : p.status === 'fixing' && p.issue ? `ronin: el arreglo en #${p.issue}` : p.status === 'minor' ? 'ronin: el prototipo' : p.status === 'reproducing' ? 'ronin: reproducirlo' : p.status === 'thinking' ? 'ronin: leerlo' : 'ronin: abrir el issue';
    case 'team': return p.pr ? `Un dev: aprobar el PR #${p.pr}` : `El equipo: #${p.issue}`;
    default: return PED_CLOSED.includes(p.status) ? 'Cerrado' : 'Nadie';
  }
}

// A reported error's six steps (#137): no prototype nor approval, its
// reproduction instead.
function pedBugStage(p) {
  const big = p.status === 'big' || p.status === 'resolved';
  const labels = ['Pedido', 'Error', 'Reproducción', big ? 'Issue del equipo' : 'Issue', 'PR', big ? 'Resuelto' : 'Listo'];
  let cur;
  let tone = 'run';
  switch (p.status) {
    case 'thinking': case 'asking': case 'answered': cur = 1; tone = p.status === 'asking' ? 'warn' : p.status === 'answered' ? 'idle' : 'run'; break;
    case 'reproducing': cur = 2; break;
    case 'fixing': cur = p.pr ? 4 : 3; tone = p.pr ? 'warn' : 'run'; break;
    case 'big': cur = 3; tone = p.issue ? 'warn' : 'run'; break;
    case 'done': case 'resolved': cur = 6; break;
    case 'declined': cur = 5; tone = 'crit'; labels[5] = 'No se hará'; break;
    default: cur = p.issue ? 3 : 2; tone = 'idle'; labels[cur] = 'Cancelado';
  }
  return { cur, tone, skip: [], labels };
}

// The seven steps, which one it's on and how ([index, tone, skipped]).
function pedStage(p) {
  if (p.bug) return pedBugStage(p);
  // A row has the verdict's kind and how many prototypes; a request's page, the verdict and the prototypes.
  const verdict = typeof p.verdict === 'string' ? p.verdict : p.verdict?.kind;
  const prototypes = Array.isArray(p.prototypes) ? p.prototypes.length : p.prototypes;
  const big = p.status === 'big' || p.status === 'resolved' || verdict === 'big';
  const skip = big && !prototypes ? [2, 3] : [];
  const labels = ['Pedido', 'Conversación', 'Prototipo', 'Aprobación', big ? 'Issue del equipo' : 'Issue', 'PR', big ? 'Resuelto' : 'Listo'];
  let cur;
  let tone = 'run';
  switch (p.status) {
    case 'thinking': case 'asking': case 'answered': cur = 1; tone = p.status === 'asking' ? 'warn' : p.status === 'answered' ? 'idle' : 'run'; break;
    case 'minor': cur = 2; break;
    case 'proposed': cur = 3; tone = 'warn'; break;
    case 'approved': cur = p.pr ? 5 : 4; tone = p.pr ? 'warn' : 'run'; break;
    case 'big': cur = 4; tone = p.issue ? 'warn' : 'run'; break;
    case 'done': case 'resolved': cur = 7; break;
    case 'declined': cur = 6; tone = 'crit'; labels[6] = 'No se hará'; break;
    default: cur = p.issue ? 4 : prototypes ? 3 : 1; tone = 'idle'; labels[cur] = 'Cancelado';
  }
  return { cur, tone, skip, labels };
}

function pedMini(p) {
  const { cur, tone, skip } = pedStage(p);
  const { labels } = pedStage(p);
  return `<span class="pd-mini" aria-hidden="true">${Array.from({ length: labels.length }, (_, i) => `<i class="${skip.includes(i) ? '' : i < cur ? 'ok' : i === cur ? tone : ''}"></i>`).join('')}</span>`;
}

function pedStepper(p) {
  const { cur, tone, skip, labels } = pedStage(p);
  return `<div class="pd-steps">${labels.map((label, i) => {
    const cls = skip.includes(i) ? 'skip' : i < cur ? 'ok' : i === cur ? tone : '';
    return `${i ? `<span class="ln ${i <= cur && !skip.includes(i) ? 'ok' : ''}"></span>` : ''}<span class="st ${cls}"><span class="b">${cls === 'ok' ? '✓' : i + 1}</span>${esc(label)}</span>`;
  }).join('')}</div>`;
}

const pedChip = (p) => {
  const [cls, label] = PED_STATUS[p.status] ?? ['idle', p.status];
  return `<span class="chip ${cls}">${esc(p.status === 'approved' && p.pr ? 'Aprobado · en un PR' : p.status === 'fixing' && p.pr ? 'En corrección · en un PR' : label)}</span>`;
};

const pedBugTag = (p) => (p.bug ? '<span class="pd-tag">Reporte de error</span>' : '');

function openPedidos() {
  S.sel = null;
  S.page = 'pedidos';
  stopStream();
  if (location.pathname !== '/pedidos') history.pushState(null, '', '/pedidos');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadPedidos();
}

function openPedido(n) {
  S.sel = null;
  S.page = 'pedido';
  if (S.ped.n !== n) {
    S.ped.tab = 'act';
    S.ped.run = null;
  }
  S.ped.n = n;
  stopStream();
  if (location.pathname !== `/pedidos/${n}`) history.pushState(null, '', `/pedidos/${n}`);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadPedido(n);
}

async function loadPedidos() {
  try {
    const { requests } = await api('/api/pedidos');
    S.ped.list = requests;
    S.ped.error = null;
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.ped.error = error.message;
  }
  S.ped.listAt = Date.now();
  if (S.page === 'pedidos') renderCenter();
}

async function loadPedido(n) {
  try {
    S.ped.detail[n] = { data: await api(pedPath(n)), at: Date.now() };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.ped.detail[n] = { ...S.ped.detail[n], error: error.message, at: Date.now() };
  }
  if (S.page === 'pedido' && S.ped.n === n) {
    renderCenter();
    // The run open on its Corridas tab, read again while it's going.
    const run = S.ped.run;
    if (run && (!run.summary || run.summary.state === 'running')) loadPedidoRun(run.runId);
  }
}

async function loadPedidoRun(runId) {
  try {
    const { summary, lines } = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (S.ped.run?.runId !== runId) return;
    S.ped.run = { runId, summary, lines: lines.filter((line) => line.type !== 'run_start' && line.type !== 'run_end') };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    if (S.ped.run?.runId === runId) S.ped.run.error = error.message;
  }
  if (S.page === 'pedido') renderCenter();
}

// The Pedidos | Usuarios tabs atop the portal's page; Usuarios, only for admins.
function portalTabsHTML(cur) {
  const total = S.snap.pedidosTotal ?? 0;
  return `<div class="doctabs pd-ptabs" role="tablist"><button class="doctab" role="tab" data-ptab="pedidos" aria-selected="${cur === 'pedidos'}">Pedidos <span class="c">${total}</span></button>${S.snap.portalAdmin ? `<button class="doctab" role="tab" data-ptab="usuarios" aria-selected="${cur === 'usuarios'}">Usuarios${S.portal.data ? ` <span class="c">${S.portal.data.users.length}</span>` : ''}</button>` : ''}</div>`;
}

function pedidosHTML() {
  const head = `<h1>Portal de pedidos</h1><p class="lead">Lo que la gente pide desde el portal y en qué va cada pedido: la conversación, lo que hizo ronin, y el issue y el PR cuando los hay.</p>${portalTabsHTML('pedidos')}`;
  const list = S.ped.list;
  if (!list) return `<div class="today pd">${head}${S.ped.error ? `<p class="bad">${esc(S.ped.error)}</p>` : '<div class="empty">Cargando…</div>'}</div>`;
  const groups = {
    todos: list,
    person: list.filter((p) => p.waitsOn === 'person'),
    ronin: list.filter((p) => p.waitsOn === 'ronin'),
    team: list.filter((p) => p.waitsOn === 'team'),
    cerrados: list.filter((p) => PED_CLOSED.includes(p.status)),
  };
  const shown = groups[S.ped.filter] ?? list;
  const rows = shown.map((p) => `<tr data-ped="${p.number}" tabindex="0"><td class="pn">P-${p.number}</td>
      <td><span class="tt">${esc(p.title)}</span>${pedBugTag(p)}<small>${esc(p.person)} · ${esc(p.appName)}${S.snap.repos.length > 1 ? ` · ${esc(repoShort(p.repo))}` : ''}</small>${pedMini(p)}</td>
      <td>${pedChip(p)}</td>
      <td class="hide-m"><span class="pd-waits">${p.running ? dotClass('live') : ''}${esc(waitsLabel(p))}</span></td>
      <td class="hide-m pd-gh">${p.issue ? `#${p.issue}` : '<span class="m">—</span>'}${p.pr ? ` · PR #${p.pr}` : ''}</td>
      <td class="hide-m m" data-ago="${esc(p.lastAt)}">${esc(ago(p.lastAt))}</td></tr>`).join('');
  return `<div class="today pd">${head}
    <div class="pd-filters">${PED_FILTERS.map(([k, label]) => `<button data-pfilter="${k}" aria-pressed="${S.ped.filter === k}">${label}<span class="c">${groups[k].length}</span></button>`).join('')}</div>
    ${rows ? `<table class="padm-t pd-t"><thead><tr><th></th><th>Pedido</th><th>Estado</th><th class="hide-m">Espera a</th><th class="hide-m">GitHub</th><th class="hide-m">Último movimiento</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="note">${list.length ? 'Ningún pedido aquí.' : 'Todavía nadie pidió nada por el portal.'}</p>`}
  </div>`;
}

// What it waits on now, and who has to do it.
function pedNowHTML(d) {
  const who = firstName(d.person);
  const running = d.runs.find((run) => run.state === 'running');
  const lastEvent = d.activity.entries.filter((e) => e.type === 'event').at(-1)?.event;
  const card = (cls, k, t, body = '', acts = '') => `<div class="pd-now ${cls}"><div class="k">${k}</div><div class="t">${t}</div>${body}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
  const open = (number, label) => `<button class="btn-s" data-pitem="${esc(`${d.repo}#${number}`)}">${esc(label)}</button>`;
  if (running) {
    return card('running', `${dotClass('live')} Ahora · ronin trabajando`, esc(`${typeName(running.taskType)}${running.issueNumber ? ` en #${running.issueNumber}` : running.prNumber ? ` en el PR #${running.prNumber}` : ''}`),
      `<div class="feed">${running.lastStep ? `▸ ${esc(running.lastStep)}` : 'Arrancando…'}</div>`, `<button class="btn-s" data-prun="${esc(running.runId)}">Ver la corrida</button>`);
  }
  if (d.waitsOn === 'ronin' && lastEvent?.kind === 'failed') {
    return card('failed', 'Ahora · falló lo último que hizo ronin', 'El tick lanza otro worker en su próxima vuelta', `<div class="err">${esc(lastEvent.error)}</div>`);
  }
  const k = `${PED_ICON.wait} Ahora`;
  switch (d.status) {
    case 'thinking': return card('running', k, 'ronin va a leerlo', '<div class="d">Espera un lugar para el agente.</div>');
    case 'minor': return card('running', k, lastEvent?.kind === 'waiting' ? 'El prototipo espera turno: hay otro en curso en este repo' : 'ronin va a armar el prototipo');
    case 'reproducing': return card('running', k, lastEvent?.kind === 'waiting' ? 'La reproducción espera turno: hay otra copia de la app en curso en este repo' : 'ronin va a reproducir el error', `<div class="d">Levanta una copia de la app con datos de prueba, sigue los pasos, escribe un test que falle y prueba el arreglo. Intento ${(d.bug?.reproductions.length ?? 0) + 1} de ${PED_REPRODUCTIONS}.</div>`);
    case 'fixing':
      if (d.pr) return card('waiting', k, esc(`Espera que un dev apruebe el PR #${d.pr}`), `<div class="d">Es el arreglo del error, partiendo del test y el diff de la reproducción. Tiene ronin:auto-merge: se mergea solo cuando lo aprueben y el CI esté verde. Al mergear, ${esc(who)} recibe “listo”.</div>`, open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.issue) return card('running', k, esc(`ronin va a hacer el arreglo en #${d.issue.number}`), `<div class="d">Lo reprodujo con un test que falla y el arreglo de prueba lo pasó a verde. ${esc(who)} no tiene que aprobar nada.</div>`, open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del arreglo');
    case 'asking': return card('waiting', k, esc(`Espera a ${who}: ronin le preguntó algo`), `<div class="d">Le escribió ${esc(ago(d.messages.at(-1)?.at))} y le avisó por correo. Lleva ${d.questions} de 3 preguntas.</div>`);
    case 'answered': return card('', k, esc(`ronin le respondió a ${who}`), '<div class="d">Puede seguir escribiendo si necesita algo más.</div>');
    case 'proposed': {
      const left = 3 - d.prototypes.length;
      return card('waiting', k, esc(`Espera a ${who}: aprobar el prototipo, pedir un ajuste o pasarlo al equipo`), `<div class="d">Se lo mostró ${esc(ago(d.prototypes.at(-1)?.at))} y le avisó por correo. ${left > 0 ? `Le ${left === 1 ? 'queda 1 ajuste' : `quedan ${left} ajustes`}.` : 'No le quedan ajustes.'}</div>`);
    }
    case 'approved':
      if (d.pr) return card('waiting', k, esc(`Espera que un dev apruebe el PR #${d.pr}`), `<div class="d">Tiene ronin:auto-merge: se mergea solo cuando lo aprueben y el CI esté verde. Al mergear, ${esc(who)} recibe “listo, sale en la próxima actualización”.</div>`, open(d.pr, `Abrir el PR #${d.pr}`));
      if (d.issue) return card('running', k, esc(`ronin va a hacer el cambio en #${d.issue.number}`), '<div class="d">Lo toma como cualquier issue asignado a ronin y abre el PR.</div>', open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del cambio');
    case 'big':
      if (d.issue) return card('waiting', k, esc(`Espera al equipo: el issue #${d.issue.number}`), `<div class="d">${esc(who)} recibe un correo cuando el issue se cierre. Mientras, ronin no hace nada más con este pedido.</div>`, open(d.issue.number, `Abrir #${d.issue.number}`));
      return card('running', k, 'ronin va a abrir el issue del equipo');
    default: {
      const [, label] = PED_STATUS[d.status] ?? ['', d.status];
      return card('closed', 'Cerrado', esc(label));
    }
  }
}

const PED_TEST = { red: 'test en rojo', green: 'test de rojo a verde', none: 'sin un test que falle' };

const MAIL_TO = (d, to) => (to === 'team' ? 'el equipo' : d.person);

// One event of its activity: [tone, icon, title, extra, small].
function pedEvent(d, e) {
  const who = d.person;
  switch (e.kind) {
    case 'worker': return ['', 'wait', e.by === 'tick' ? 'El tick vio el pedido sin worker y lanzó otro' : 'Se lanzó un worker', '', true];
    case 'failed': return ['crit', 'crit', { classify: 'Falló al leerlo', prototype: 'Falló un intento de prototipo', reproduce: 'Falló un intento de reproducción', worker: 'El worker falló' }[e.step] ?? 'Falló', `<div class="bx err">${esc(e.error)}</div>`];
    case 'waiting': return ['', 'wait', d.bug ? 'La reproducción esperó turno: había otra copia de la app en curso en el repo' : 'El prototipo esperó turno: había otro en curso en el repo', '', true];
    case 'reproduced': return e.reproduced
      ? ['ok', 'ok', `Lo reprodujo (intento ${e.round})`, `<span class="m">${esc(PED_TEST[e.test])}</span>`, true]
      : ['warn', 'crit', `No lo pudo reproducir (intento ${e.round})`, `<span class="m">${esc(PED_TEST[e.test])}</span>`, true];
    case 'classified': return e.verdict === 'minor'
      ? ['ok', 'ok', 'Lo clasificó como cambio menor', d.verdict?.kind === 'minor' && d.verdict.proposal ? `<div class="bx">${esc(d.verdict.proposal)}</div>` : '']
      : e.verdict === 'error' ? ['run', 'run', 'Lo leyó como un reporte de error', d.bug?.steps ? `<div class="bx">${esc(d.bug.steps)}</div>` : '']
      : ['warn', 'crit', 'Lo pasó al equipo', d.verdict?.kind === 'big' && d.verdict.reason ? `<div class="bx">${esc(d.verdict.reason)}</div>` : ''];
    case 'decided': return e.decision === 'approved' ? ['ok', 'ok', `${who} aprobó el prototipo`, ''] : ['warn', 'person', `${who} no aprobó el prototipo`, ''];
    case 'mail': return [e.ok ? 'mail' : 'crit', 'mail', e.ok ? `Correo a ${MAIL_TO(d, e.to)}` : `No salió el correo a ${MAIL_TO(d, e.to)}`, `<span class="m">${esc(e.subject)}</span>`, e.ok];
    case 'issue': return ['ok', 'ok', e.team ? `Abrió el issue del equipo #${e.number}` : `Abrió el issue #${e.number} para ronin`, ''];
    case 'pr': return ['ok', 'ok', `ronin abrió el PR #${e.number}, con ronin:auto-merge`, ''];
    case 'pr-closed': return ['warn', 'crit', `El PR #${e.number} se cerró sin merge`, ''];
    case 'closed': return e.status === 'done' ? ['ok', 'ok', 'Se mergeó: sale en la próxima actualización', ''] : e.status === 'resolved' ? ['ok', 'ok', 'El equipo cerró el issue como resuelto', ''] : ['', 'crit', 'El equipo decidió no hacerlo por ahora', ''];
    case 'cancelled': return ['', 'person', `${who} lo canceló`, ''];
    default: return ['', 'wait', e.kind, ''];
  }
}

function pedRunCard(run) {
  const live = run.state === 'running';
  return `<div class="pd-run">${dot(run.state)}<span class="nm">${esc(typeName(run.taskType))}${run.issueNumber ? ` · #${run.issueNumber}` : run.prNumber ? ` · PR #${run.prNumber}` : ''}</span>
    <span class="st">${live ? '<span data-since="' + esc(run.startedAt) + '"></span>' : [run.durationMs !== undefined ? duration(run.durationMs) : null, run.costUsd !== undefined ? money(run.costUsd) : null, STATE[run.state]?.[2]].filter(Boolean).map(esc).join(' · ')}</span>
    <button class="go" data-prun="${esc(run.runId)}">${live ? 'Ver en vivo' : 'Ver corrida'} →</button>
    ${run.lastStep ? `<span class="last">${live ? '▸' : 'último:'} ${esc(run.lastStep)}</span>` : ''}</div>`;
}

function pedThumbs(d, m) {
  if (!m.images.length) return '';
  return `<div class="pd-thumbs">${m.images.map((file, i) => `<figure><button data-plb="${esc(file)}"><img src="${esc(pedImg(d.number, file))}" alt="${esc(m.captions?.[i] ?? 'Imagen')}" loading="lazy"></button>${m.captions?.[i] ? `<figcaption>${esc(m.captions[i].split(':')[0])}</figcaption>` : ''}</figure>`).join('')}</div>`;
}

function pedEntryHTML(d, e) {
  const item = (tone, icon, title, extra, time, small = false, body = '') => `<li class="pd-ev ${tone} ${small ? 'small' : ''}"><span class="ic">${PED_ICON[icon] ?? PED_ICON.wait}</span><div class="h"><b>${title}</b>${extra}<span class="tm" title="${esc(time ? when(time) : '')}">${time ? esc(hhmm(time)) : 'sin hora'}</span></div>${body}</li>`;
  if (e.type === 'run') return item('run', 'run', esc(e.run.taskType === 'portal-prototype' ? 'Armó el prototipo' : e.run.taskType === 'portal-reproduce' ? 'Intentó reproducirlo' : e.run.taskType === 'portal-request' ? 'ronin lo leyó' : typeName(e.run.taskType)), '', e.at, false, pedRunCard(e.run));
  if (e.type === 'message') {
    const m = e.message;
    const long = m.text.length > 320;
    const text = `<div class="bx ${m.from === 'person' ? 'q' : 'r'}">${esc(long ? `${m.text.slice(0, 300)}…` : m.text)}${long ? ' <button class="more" data-ptab2="chat">Ver completo</button>' : ''}</div>`;
    const tried = d.bug?.reproductions.find((t) => t.messageId === m.id);
    const title = m.from === 'person' ? (e.first ? `${esc(d.person)} abrió el pedido` : `${esc(d.person)} escribió`) : e.prototype ? `Le mostró el prototipo ${e.prototype}` : tried ? `Le contó lo que encontró (intento ${tried.round})` : 'ronin le respondió';
    const extra = e.first ? `<span class="m">${esc(d.appName)}</span>` : '';
    const proto = e.prototype && d.prototypes.find((p) => p.round === e.prototype)?.patch ? `<button class="more" data-ptab2="team">Ver el borrador para el equipo →</button>`
      : tried ? `<button class="more" data-ptab2="repro">Ver la reproducción →</button>` : '';
    return item(m.from === 'person' ? 'person' : 'ronin', m.from === 'person' ? 'person' : 'ronin', title, extra, e.at, false, text + pedThumbs(d, m) + proto);
  }
  const [tone, icon, title, extra, small] = pedEvent(d, e.event);
  return item(tone, icon, esc(title), small ? extra : '', e.at, small, small ? '' : extra);
}

function pedActivityHTML(d) {
  const { entries, untimed } = d.activity;
  return pedNowHTML(d) + `<ol class="pd-tl">${entries.map((e) => pedEntryHTML(d, e)).join('')}${untimed.map((ev) => pedEntryHTML(d, { type: 'event', at: '', event: ev })).join('')}</ol>`;
}

function pedChatHTML(d) {
  return `<p class="m pd-note">Lo mismo que ve ${esc(firstName(d.person))} en el portal.</p><div class="pd-chat">${d.messages.map((m) => `<div class="msg ${m.from}"><div class="w">${m.from === 'person' ? esc(d.person) : 'ronin'} · ${esc(when(m.at))}</div>${esc(m.text)}${pedThumbs(d, m)}</div>`).join('')}</div>`;
}

function pedTeamHTML(d) {
  const v = d.verdict;
  if (!v) return '<p class="note">ronin todavía no lo clasificó.</p>';
  const block = (title, text) => (text ? `<h4>${esc(title)}</h4><p>${esc(text)}</p>` : '');
  const protos = d.prototypes.map((p) => {
    const patch = S.ped.patch[`${d.number}:${p.round}`];
    return `<h4>Prototipo ${p.round} · ${esc(when(p.at))}</h4><p>${esc(p.summary)}</p>${p.patch ? (patch?.text ? `<div class="m">${esc(diffStat(patch.text))}</div>${diffHTML(patch.text)}` : `<button class="btn-s" data-ppatch="${p.round}">${patch?.loading ? 'Cargando…' : patch?.error ? 'No se pudo leer: reintentar' : 'Ver el diff'}</button>`) : '<p class="m">Sin diff: el después es una maqueta.</p>'}`;
  }).join('');
  return `<div class="pd-doc">${v.kind === 'big' ? block('Por qué es para el equipo', v.reason) : block('Qué cambia, en palabras de la persona', v.proposal)}${block('Cómo reproducirlo, según ronin', d.bug?.steps)}${block('Resumen técnico', v.summary)}${block('Lo que se le pidió al prototipo', v.instruction)}${protos}</div>`;
}

// Where a try left it: ronin fixes it, the person answers, or the team.
function pedReproGoes(d, t, last) {
  if (!last) return ['', 'Siguiente intento', `${d.bug.reproductions.length} de ${PED_REPRODUCTIONS}`];
  if (['fixing', 'done'].includes(d.status) && t.fix === 'small') return ['ok', 'ronin', 'hace el arreglo; un dev aprueba el PR'];
  if (d.status === 'asking' || d.status === 'thinking' || d.status === 'reproducing') return ['warn', `${firstName(d.person)}`, 'le preguntó lo que necesita'];
  if (d.status === 'cancelled') return ['', 'Nadie', 'cancelado'];
  return ['', 'Equipo', d.issue ? `issue #${d.issue.number}` : 'va a abrir el issue'];
}

// A reported error's tries (#137), newest first: what ronin did, its test
// red and green, its images and its diff.
function pedReproHTML(d) {
  const tries = d.bug?.reproductions ?? [];
  if (!tries.length) return `<div class="pd-doc">${d.bug?.steps ? `<h4>Cómo reproducirlo, según ronin</h4><p>${esc(d.bug.steps)}</p>` : ''}<p class="note">${d.status === 'reproducing' ? 'ronin todavía no termina el primer intento.' : 'Todavía no hay intentos.'}</p></div>`;
  return tries.slice().reverse().map((t, i) => {
    const last = i === 0;
    const test = t.test;
    const [goTone, goWho, goWhat] = pedReproGoes(d, t, last);
    const shown = d.messages.find((m) => m.id === t.messageId);
    const patch = S.ped.patch[`${d.number}:r${t.round}`];
    const out = (label, text, cls) => (text ? `<div class="pd-out"><div class="lab"><span class="chip ${cls}">${label}</span></div><pre>${esc(text)}</pre></div>` : '');
    return `<section class="pd-repro">
      <h4>Intento ${t.round} · ${esc(when(t.at))}</h4>
      <div class="pd-vc">
        <div class="${t.reproduced ? 'ok' : 'warn'}"><span class="k">Reproducción</span><b>${t.reproduced ? '✓ Reproducido' : '✕ No se reprodujo'}</b><span class="m">con datos de prueba</span></div>
        <div class="${test?.red ? (test.green ? 'ok' : 'crit') : ''}"><span class="k">Test</span><b>${!test ? 'Sin test' : !test.red ? 'Sin test rojo' : test.green ? 'Rojo → verde' : 'Rojo'}</b><span class="m">${test ? (test.kind === 'e2e' ? 'e2e' : 'directo en la capa') : '—'}</span></div>
        <div class="${goTone}"><span class="k">Ahora</span><b>${esc(goWho)}</b><span class="m">${esc(goWhat)}</span></div>
      </div>
      <div class="pd-doc">
        ${t.steps.length ? `<h4>Lo que hizo ronin</h4><ol>${t.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
        ${t.summary ? `<h4>${t.reproduced ? 'Causa' : 'Lo que sospecha ronin'}</h4><p>${esc(t.summary)}</p>` : ''}
        ${t.fix === 'big' && t.reason ? `<h4>Por qué el arreglo no es pequeño</h4><p>${esc(t.reason)}</p>` : ''}
        ${shown ? pedThumbs(d, shown) : ''}
        ${test ? `<h4>El test</h4><p><code>${esc(test.name)}</code>${test.file ? ` en <code>${esc(test.file)}</code>` : ''}${test.command ? `<br><span class="m">${esc(test.command)}</span>` : ''}</p>${!test.red ? '<p class="m">No falla con datos de prueba: no prueba el error, es lo que se intentó.</p>' : ''}
          <div class="pd-tdd">${out(test.red ? 'Rojo' : 'Salida', test.redOutput, test.red ? 'crit' : '')}${test.green ? out('Verde', test.greenOutput, 'ok') : ''}</div>` : ''}
        ${t.patch ? `<h4>Diff ${t.fix === 'small' ? '(el test y el arreglo de prueba)' : '(el test)'}</h4>${patch?.text ? `<div class="m">${esc(diffStat(patch.text))}</div>${diffHTML(patch.text)}` : `<button class="btn-s" data-prpatch="${t.round}">${patch?.loading ? 'Cargando…' : patch?.error ? 'No se pudo leer: reintentar' : 'Ver el diff'}</button>`}` : ''}
      </div></section>`;
  }).join('');
}

function pedRunsHTML(d) {
  if (!d.runs.length) return '<p class="note">Sin corridas en los últimos 14 días.</p>';
  const open = S.ped.run;
  const list = d.runs.map((run) => `<div class="pd-runrow ${open?.runId === run.runId ? 'cur' : ''}"><span class="tm">${esc(when(run.startedAt))}</span>${pedRunCard(run)}</div>`).join('');
  if (!open) return list;
  const body = open.summary
    ? `<div class="tx pd-tx">${open.lines.map(step).join('') || '<div class="empty">El agente todavía no hizo nada.</div>'}${ending(open.summary)}</div>`
    : `<div class="empty">${open.error ? esc(open.error) : 'Cargando la corrida…'}</div>`;
  return `<div class="pd-runview"><div class="pd-runbar"><b>${esc(typeName(open.summary?.taskType ?? ''))}</b><span class="m">${open.summary ? esc(when(open.summary.startedAt)) : ''}</span><button class="btn-s" data-prunx>Cerrar</button></div>${body}</div>${list}`;
}

function pedSideHTML(d) {
  const mails = d.activity.entries.filter((e) => e.type === 'event' && e.event.kind === 'mail');
  const gh = (number, url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a> <button class="link" data-pitem="${esc(`${d.repo}#${number}`)}">en el tablero</button>`;
  return `<div class="pd-side">
    <div class="pd-card"><h3>Pedido</h3><dl class="kv">
      <dt>Quién</dt><dd>${esc(d.person)}${d.email ? `<small>${esc(d.email)}</small>` : ''}</dd>
      <dt>App</dt><dd>${esc(d.appName)} <small>${esc(d.repo)}</small></dd>
      <dt>Abierto</dt><dd>${esc(when(d.createdAt))}</dd>
      <dt>Preguntas</dt><dd>${d.questions} de 3</dd>
      ${d.bug ? `<dt>Reproducciones</dt><dd>${d.bug.reproductions.length} de ${PED_REPRODUCTIONS}</dd>` : `<dt>Prototipos</dt><dd>${d.prototypes.length} de 3</dd>`}
      ${d.issue ? `<dt>Issue</dt><dd>${gh(d.issue.number, issueUrl(d.repo, d.issue.number) ?? '#', `#${d.issue.number}`)}</dd>` : ''}
      ${d.pr ? `<dt>PR</dt><dd>${gh(d.pr, prUrl(d.repo, d.pr) ?? '#', `#${d.pr}`)}</dd>` : ''}
    </dl></div>
    <div class="pd-card"><h3>Corridas</h3>${d.runs.length ? `<div class="pd-costs">${d.runs.slice().reverse().map((run) => `<div><span>${esc(typeName(run.taskType))}</span><span>${run.costUsd !== undefined ? esc(money(run.costUsd)) : run.state === 'running' ? 'en curso' : '—'}</span></div>`).join('')}<div class="tot"><span>${d.runs.length} ${d.runs.length === 1 ? 'corrida' : 'corridas'}</span><span>${esc(money(d.costUsd))}</span></div></div>` : '<p class="m">Ninguna en los últimos 14 días.</p>'}</div>
    ${mails.length ? `<div class="pd-card"><h3>Correos</h3><div class="pd-mails">${mails.map((e) => `<div class="${e.event.ok ? '' : 'bad'}"><span class="tm">${esc(hhmm(e.at))}</span><span>${e.event.ok ? '' : 'no salió · '}a ${esc(MAIL_TO(d, e.event.to))}</span></div>`).join('')}</div></div>` : ''}
  </div>`;
}

function pedidoHTML() {
  const n = S.ped.n;
  const entry = S.ped.detail[n];
  const d = entry?.data;
  if (!d) return `<div class="today pd">${entry?.error ? `<p class="bad">${esc(entry.error)}</p>` : '<div class="empty">Cargando…</div>'}</div>`;
  const counts = { chat: d.messages.length, runs: d.runs.length, repro: d.bug?.reproductions.length };
  // Reproducción, only for a reported error.
  const tabs = PED_TABS.filter(([k]) => k !== 'repro' || d.bug);
  const tab = tabs.some(([k]) => k === S.ped.tab) ? S.ped.tab : 'act';
  const body = tab === 'chat' ? pedChatHTML(d) : tab === 'team' ? pedTeamHTML(d) : tab === 'runs' ? pedRunsHTML(d) : tab === 'repro' ? pedReproHTML(d) : pedActivityHTML(d);
  return `<div class="head pd-head"><div class="crumb"><button class="link" data-ppage>Portal de pedidos</button> / <i style="background:${repoColor(d.repo)}"></i>${esc(repoShort(d.repo))} · ${esc(d.appName)}</div>
      <div class="row"><h1>${esc(d.title)} <span class="n">P-${d.number}</span></h1></div>
      <div class="state">${pedChip(d)}${pedBugTag(d)}<span>${esc(d.person)}</span><span class="m">abierto ${esc(ago(d.createdAt))}</span>${d.issue ? `<button class="link" data-pitem="${esc(`${d.repo}#${d.issue.number}`)}">#${d.issue.number}</button>` : ''}${d.pr ? `<button class="link" data-pitem="${esc(`${d.repo}#${d.pr}`)}">PR #${d.pr}</button>` : ''}</div>
      ${pedStepper(d)}</div>
    <div class="doctabs" role="tablist">${tabs.map(([k, label]) => `<button class="doctab" role="tab" data-ptab2="${k}" aria-selected="${tab === k}">${label}${counts[k] ? ` <span class="c">${counts[k]}</span>` : ''}</button>`).join('')}</div>
    <div class="pd-body"><div class="pd-cols"><div class="pd-main">${body}</div>${pedSideHTML(d)}</div></div>`;
}

function pedLightbox() {
  let box = $('#lightbox');
  const lb = S.ped.lb;
  if (!lb) {
    box?.remove();
    return;
  }
  if (!box) box = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'lightbox', className: 'lightbox' });
  box.innerHTML = `<div class="lt"><b>P-${lb.n}</b><span class="m">${esc(lb.file)}</span><button id="lb-x">Cerrar ✕</button></div><div class="lb"><figure><div><img src="${esc(pedImg(lb.n, lb.file))}" alt=""></div></figure></div>`;
  $('#lb-x').onclick = () => { S.ped.lb = null; pedLightbox(); };
}

// A prototype's diff, or a reproduction's (#137).
async function loadPatch(n, round, of = 'prototipo') {
  const key = `${n}:${of === 'prototipo' ? '' : 'r'}${round}`;
  S.ped.patch[key] = { loading: true };
  renderCenter();
  try {
    S.ped.patch[key] = { text: (await api(pedPath(n, `/${of}/${round}`))).patch };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.ped.patch[key] = { error: error.message };
  }
  renderCenter();
}

function wirePedidos() {
  const center = $('#center');
  for (const b of center.querySelectorAll('[data-ptab]')) b.onclick = () => (b.dataset.ptab === 'usuarios' ? openPortal() : openPedidos());
  for (const b of center.querySelectorAll('[data-pfilter]')) b.onclick = () => { S.ped.filter = b.dataset.pfilter; renderCenter(); };
  for (const row of center.querySelectorAll('[data-ped]')) {
    row.onclick = () => openPedido(Number(row.dataset.ped));
    row.onkeydown = (event) => { if (event.key === 'Enter') openPedido(Number(row.dataset.ped)); };
  }
  center.querySelector('[data-ppage]')?.addEventListener('click', openPedidos);
  for (const b of center.querySelectorAll('[data-ptab2]')) b.onclick = () => { S.ped.tab = b.dataset.ptab2; renderCenter(); };
  for (const b of center.querySelectorAll('[data-pitem]')) b.onclick = () => select(b.dataset.pitem);
  for (const b of center.querySelectorAll('[data-prun]')) {
    b.onclick = () => {
      S.ped.tab = 'runs';
      S.ped.run = { runId: b.dataset.prun };
      renderCenter();
      $('#center .pd-body')?.scrollTo(0, 0);
      loadPedidoRun(b.dataset.prun);
    };
  }
  center.querySelector('[data-prunx]')?.addEventListener('click', () => { S.ped.run = null; renderCenter(); });
  for (const b of center.querySelectorAll('[data-plb]')) b.onclick = () => { S.ped.lb = { n: S.ped.n, file: b.dataset.plb }; pedLightbox(); };
  for (const b of center.querySelectorAll('[data-ppatch]')) b.onclick = () => loadPatch(S.ped.n, Number(b.dataset.ppatch));
  for (const b of center.querySelectorAll('[data-prpatch]')) b.onclick = () => loadPatch(S.ped.n, Number(b.dataset.prpatch), 'reproduccion');
}

// ---------- meetings (#62)
// The team uploads a meeting's notes (a PDF, a Word .docx, text, or pasted)
// and ronin proposes the work that comes out of it. Anyone who sees a repo
// uploads to it and sees its meetings. The notes stay on the runner.
const REU_STATUS = {
  pending: ['run', 'En cola para ronin'], reading: ['run', 'ronin la está leyendo'], review: ['warn', 'Espera revisión'],
  empty: ['idle', 'Nada accionable'], failed: ['crit', 'Falló la lectura'], done: ['ok', 'Creado'], discarded: ['idle', 'Descartada'],
};
const REU_KIND = { pdf: 'PDF', docx: 'Word', text: 'Texto', pasted: 'Pegado' };
const REU_MAX_BYTES = 10 * 1024 * 1024;
const REU_CYCLE = { current: 'el ciclo actual', next: 'el próximo ciclo' };
const reuPath = (n, rest = '') => `/api/reuniones/${n}${rest}`;
const reuChip = (m) => {
  const [cls, label] = REU_STATUS[m.status] ?? ['idle', m.status];
  return `<span class="chip ${cls}">${m.status === 'reading' ? dotClass('live') : ''}${esc(label)}</span>`;
};
const reuSource = (m) => `${REU_KIND[m.source.kind] ?? m.source.kind}${m.source.pages ? ` · ${m.source.pages} ${m.source.pages === 1 ? 'página' : 'páginas'}` : ''}`;
const reuChars = (n) => `${n.toLocaleString('es')} caracteres`;
// The notes' lines with text, numbered from 1: what ronin cites (meetings.ts's noteLines).
const reuLines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function reuCounts(c) {
  if (!c) return '<span class="m">—</span>';
  const parts = [c.projects ? plural(c.projects, 'proyecto', 'proyectos') : '', c.issues ? plural(c.issues, 'issue', 'issues') : '', c.comments ? plural(c.comments, 'comentario', 'comentarios') : ''].filter(Boolean);
  return `<span class="reu-counts">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}<span class="m">${esc(plural(c.discarded, 'descartado', 'descartados'))}</span></span>`;
}

function openReuniones() {
  S.sel = null;
  S.page = 'reuniones';
  stopStream();
  if (location.pathname !== '/reuniones') history.pushState(null, '', '/reuniones');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadReuniones();
}

function openReunion(n) {
  S.sel = null;
  S.page = 'reunion';
  if (S.reu.n !== n) {
    S.reu.tab = null;
    S.reu.run = null;
    S.reu.open = {};
  }
  S.reu.n = n;
  stopStream();
  if (location.pathname !== `/reuniones/${n}`) history.pushState(null, '', `/reuniones/${n}`);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadReunion(n);
}

async function loadReuniones() {
  try {
    S.reu.list = (await api('/api/reuniones')).meetings;
    S.reu.error = null;
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.reu.error = error.message;
  }
  S.reu.listAt = Date.now();
  if (S.page === 'reuniones') renderCenter();
}

async function loadReunion(n) {
  try {
    S.reu.detail[n] = { data: await api(reuPath(n)), at: Date.now() };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    S.reu.detail[n] = { ...S.reu.detail[n], error: error.message, at: Date.now() };
  }
  if (S.page === 'reunion' && S.reu.n === n) {
    // Not under someone typing in the review: it'd take their cursor away.
    if (!document.activeElement?.closest?.('[data-reuf]')) renderCenter();
    const run = S.reu.run;
    if (run && (!run.summary || run.summary.state === 'running')) loadReunionRun(run.runId);
  }
}

async function loadReunionRun(runId) {
  try {
    const { summary, lines } = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (S.reu.run?.runId !== runId) return;
    S.reu.run = { runId, summary, lines: lines.filter((line) => line.type !== 'run_start' && line.type !== 'run_end') };
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    if (S.reu.run?.runId === runId) S.reu.run.error = error.message;
  }
  if (S.page === 'reunion') renderCenter();
}

function reunionesHTML() {
  const head = `<div class="reu-top"><div><h1>Reuniones</h1><p class="lead">Sube las notas de una reunión (PDF, Word o texto) y ronin propone el trabajo que sale de ella: proyectos de Linear, issues y comentarios en issues que ya existen. Nada se crea hasta que alguien lo apruebe aquí.</p></div>
    <button class="btn-s primary" data-reunew>+ Subir notas</button></div>`;
  const list = S.reu.list;
  if (!list) return `<div class="today pd">${head}${S.reu.error ? `<p class="bad">${esc(S.reu.error)}</p>` : '<div class="empty">Cargando…</div>'}</div>`;
  const rows = list.map((m) => `<tr data-reu="${m.number}" tabindex="0"><td class="pn">R-${m.number}</td>
      <td><span class="tt">${esc(m.title)}</span><small>${m.at ? `${esc(when(m.at))} · ` : ''}${esc(repoShort(m.repo))} · ${esc(reuSource(m))}</small></td>
      <td>${reuChip(m)}</td>
      <td class="hide-m">${reuCounts(m.counts)}</td>
      <td class="hide-m m">${esc(m.by)} · <span data-ago="${esc(m.createdAt)}">${esc(ago(m.createdAt))}</span></td></tr>`).join('');
  return `<div class="today pd">${head}
    ${rows ? `<table class="padm-t pd-t"><thead><tr><th></th><th>Reunión</th><th>Estado</th><th class="hide-m">Propuestas</th><th class="hide-m">Subida por</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="note">Todavía nadie subió las notas de una reunión.</p>'}
  </div>`;
}

// The lines of the notes a proposal cites, folded until asked for.
function reuCites(d, key, cites) {
  if (!cites.length) return '';
  const lines = reuLines(d.text);
  const open = S.reu.open[key];
  return `<button class="reu-x" data-reuopen="${esc(key)}">${open ? '▾' : '▸'} De las notas${cites.length > 1 ? ` (${cites.length})` : ''}</button>
    ${open ? cites.map((c) => `<blockquote class="reu-q">${esc(lines[c - 1] ?? '')}<button class="reu-src-l" data-reuline="${c}">línea ${c} en las notas</button></blockquote>`).join('') : ''}`;
}

function reuBody(key, label, body) {
  const open = S.reu.open[key];
  return `<button class="reu-x" data-reuopen="${esc(key)}">${open ? '▾' : '▸'} ${esc(label)}</button>${open ? `<div class="md reu-md">${md(body, S.reu.detail[S.reu.n]?.data?.repo ?? '')}</div>` : ''}`;
}

const reuMeta = (parts) => (parts.filter(Boolean).length ? `<div class="reu-meta">${parts.filter(Boolean).join('')}</div>` : '');
const reuCycle = (cycle) => (cycle ? `<span>${LIN_ICON} ${esc(REU_CYCLE[cycle] ?? cycle)}</span>` : '');

// The review (#62, entrega 3): what the person marks and changes, by
// proposal id, kept while the page is open.
function reuForm(d) {
  const key = d.number;
  if (S.reu.form[key]) return S.reu.form[key];
  const p = d.proposals;
  const f = { on: {}, title: {}, body: {}, lead: {}, project: {}, cycle: {}, edit: {} };
  const all = [...p.projects.flatMap((x) => [x, ...x.issues]), ...p.issues, ...p.comments];
  for (const x of all) f.on[x.id] = !d.results[x.id]?.ok;
  S.reu.form[key] = f;
  return f;
}

const reuEditable = (d) => d.status === 'review';
// Dimmed: unmarked while reviewing, or left out once it's decided.
const reuOff = (d, id) => !d.results[id]?.ok && (reuEditable(d) ? !reuForm(d).on[id] : d.status === 'done' || d.status === 'discarded');
const reuPlanning = (d) => linearRepos().find((l) => l.repo === d.repo)?.planning ?? null;

// The current cycle and the next, by what the page knows of Linear.
function reuCycleLabels(d) {
  const cycles = reuPlanning(d)?.cycles ?? [];
  const current = cycles.find((c) => c.current);
  const next = cycles.find((c) => !c.current && (!current || c.startsAt >= current.endsAt));
  return { current: current ? `${cycleName(current)} (el actual)` : 'El ciclo actual', next: next ? `${cycleName(next)} (el próximo)` : 'El próximo ciclo' };
}

// What became of it, once approved.
function reuResult(d, id) {
  const r = d.results[id];
  if (!r) return '';
  if (!r.ok) return `<div class="reu-res bad">No se pudo crear: ${esc(r.error)}</div>`;
  const label = r.projectId ? 'Proyecto creado en Linear' : r.number && d.proposals.comments.some((c) => c.id === id) ? `Comentado en #${r.number}` : `Creado #${r.number}`;
  const href = typeof r.url === 'string' && /^https:\/\/(github\.com|linear\.app)\//.test(r.url) ? r.url : null;
  return `<div class="reu-res ok">✓ ${esc(label)}${href ? ` <a href="${esc(href)}" target="_blank" rel="noopener">abrir ↗</a>` : ''}${r.number && !r.projectId ? ` <button class="link" data-reuitem="${esc(`${d.repo}#${r.number}`)}">en el tablero</button>` : ''}<span class="m"> · ${esc(r.by)}</span></div>`;
}

function reuCheck(d, id, label) {
  if (!reuEditable(d) || d.results[id]?.ok) return '';
  const f = reuForm(d);
  return `<input type="checkbox" class="reu-chk" data-reuchk="${esc(id)}" ${f.on[id] ? 'checked' : ''} aria-label="${esc(label)}">`;
}

function reuTitle(d, id, value, label) {
  const f = reuEditable(d) && !d.results[id]?.ok ? reuForm(d) : null;
  if (!f) return `<b>${esc(value)}</b>`;
  return `<input class="reu-ti" data-reuf="title" data-reuid="${esc(id)}" maxlength="256" value="${esc(f.title[id] ?? value)}" aria-label="${esc(label)}">`;
}

function reuSelect(d, field, id, value, options, label) {
  const f = reuForm(d);
  const cur = f[field][id] ?? value ?? '';
  return `<label class="reu-sel">${label} <select data-reuf="${field}" data-reuid="${esc(id)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

function reuCycleField(d, id, value, label = `${LIN_ICON} Ciclo`) {
  if (!reuPlanning(d)) return '';
  if (!reuEditable(d) || d.results[id]?.ok) return reuCycle(value);
  const labels = reuCycleLabels(d);
  return reuSelect(d, 'cycle', id, value, [['', 'sin ciclo'], ['current', labels.current], ['next', labels.next]], label);
}

// The description: shown, or a textarea while editing it.
function reuText(d, key, id, label, body) {
  const f = reuEditable(d) && !d.results[id]?.ok ? reuForm(d) : null;
  if (!f) return reuBody(key, label, body);
  const open = S.reu.open[key];
  return `<button class="reu-x" data-reuopen="${esc(key)}">${open ? '▾' : '▸'} ${esc(label)}${f.body[id] !== undefined ? ' · editada' : ''}</button>${open ? `<textarea class="reu-ta" data-reuf="body" data-reuid="${esc(id)}" rows="8">${esc(f.body[id] ?? body)}</textarea>` : ''}`;
}

function reuIssueHTML(d, i, kid = false) {
  const planning = reuPlanning(d);
  const projectField = !kid && planning && reuEditable(d) && !d.results[i.id]?.ok
    ? reuSelect(d, 'project', i.id, i.project ?? '', [['', 'sin proyecto'], ...[...new Set([...(i.project ? [i.project] : []), ...planning.projects.map((x) => x.name)])].map((x) => [x, x])], `${LIN_ICON} Proyecto`)
    : i.project ? `<span>${LIN_ICON} ${esc(i.project)}</span>` : '';
  return `<div class="reu-pr ${kid ? 'reu-kid' : ''} ${reuOff(d, i.id) ? 'off' : ''}"><div class="reu-h">${reuCheck(d, i.id, 'Incluir este issue')}<span class="reu-kind iss">issue</span>${reuTitle(d, i.id, i.title, 'Título del issue')}</div>
    ${i.why ? `<div class="reu-why">${esc(i.why)}</div>` : ''}
    ${reuMeta([projectField, reuCycleField(d, i.id, i.cycle)])}
    <div class="reu-xs">${reuCites(d, `q-${i.id}`, i.cites)}${reuText(d, `b-${i.id}`, i.id, 'Descripción', i.body)}</div>${reuResult(d, i.id)}</div>`;
}

function reuProposalsHTML(d) {
  const p = d.proposals;
  if (!p) return '<p class="note">Todavía no hay propuestas: ronin no terminó de leer las notas.</p>';
  const editable = reuEditable(d);
  const off = (id) => reuOff(d, id);
  const sec = (title, n, html, hint = '') => (n ? `<section class="reu-sec"><h2>${title} <span class="c">${n}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</h2>${html}</section>` : '');
  const planning = reuPlanning(d);
  const projects = p.projects.map((x) => `<div class="reu-pr proj ${off(x.id) ? 'off' : ''}"><div class="reu-h">${reuCheck(d, x.id, 'Incluir este proyecto')}<span class="reu-kind proj">${LIN_ICON} proyecto nuevo</span>${reuTitle(d, x.id, x.name, 'Nombre del proyecto')}</div>
      ${x.why ? `<div class="reu-why">${esc(x.why)}</div>` : ''}
      ${reuMeta(['<span>Linear · estado Backlog</span>', editable && planning && !d.results[x.id]?.ok ? reuSelect(d, 'lead', x.id, x.lead ?? '', [['', 'sin líder'], ...planning.people.map((u) => [u.name, u.name])], 'Líder') : x.lead ? `<span>líder ${esc(x.lead)}</span>` : ''])}
      <div class="reu-xs">${reuCites(d, `q-${x.id}`, x.cites)}${x.description ? reuText(d, `b-${x.id}`, x.id, 'Descripción', x.description) : ''}</div>${reuResult(d, x.id)}
      <div class="reu-kids"><div class="reu-kids-h">Sus issues · en GitHub, dentro de este proyecto</div>${x.issues.map((i) => reuIssueHTML(d, i, true)).join('')}</div></div>`).join('');
  const comments = p.comments.map((c) => `<div class="reu-pr ${off(c.id) ? 'off' : ''}"><div class="reu-h">${reuCheck(d, c.id, 'Incluir este comentario')}<span class="reu-kind com">comentario</span><b>en <button class="link" data-reuitem="${esc(`${d.repo}#${c.issue}`)}">#${c.issue}</button> <span class="reu-it">${esc(c.issueTitle)}</span></b></div>
      ${c.why ? `<div class="reu-why">${esc(c.why)}</div>` : ''}
      ${reuMeta([reuCycleField(d, c.id, c.cycle, `${LIN_ICON} Pasarlo a`)])}
      <div class="reu-xs">${reuCites(d, `q-${c.id}`, c.cites)}${reuText(d, `b-${c.id}`, c.id, 'Comentario', c.body)}</div>${reuResult(d, c.id)}</div>`).join('');
  const discarded = p.discarded.map((x, i) => `<div class="reu-disc"><b>${esc(x.topic)}</b><span class="reu-why">${esc(x.why)}</span><div class="reu-xs">${reuCites(d, `d-${i}`, x.cites)}</div></div>`).join('');
  const done = d.status === 'done' ? '<div class="pd-now"><div class="k">' + PED_ICON.ok + ' Creado</div><div class="t">Se creó todo lo aprobado</div><div class="d">Lo que no se marcó quedó fuera. Los issues se crearon sin asignar: el equipo decide quién los toma.</div></div>'
    : d.status === 'discarded' ? `<div class="pd-now"><div class="k">${PED_ICON.ok} Descartada</div><div class="t">${Object.values(d.results).some((r) => r.ok) ? 'Lo que faltaba quedó fuera' : 'No se creó nada de esta reunión'}</div></div>` : '';
  return `${done}${p.summary ? `<p class="reu-summary">${esc(p.summary)}</p>` : ''}
    ${sec('Proyectos', p.projects.length, projects, 'en Linear: GitHub no tiene proyectos')}
    ${sec('Issues', p.issues.length, p.issues.map((i) => reuIssueHTML(d, i)).join(''))}
    ${sec('En issues que ya existen', p.comments.length, comments)}
    ${sec('Descartado', p.discarded.length, `<div class="reu-discs">${discarded}</div>`, 'lo que se habló y no pide trabajo nuevo')}
    ${editable ? reuApproveBar(d) : ''}`;
}

// What will be created: the marked ones not created yet.
function reuChosen(d) {
  const f = reuForm(d);
  const p = d.proposals;
  const pick = (x) => f.on[x.id] && !d.results[x.id]?.ok;
  const projects = p.projects.filter(pick).length;
  const issues = [...p.projects.flatMap((x) => x.issues), ...p.issues].filter(pick).length;
  const comments = p.comments.filter(pick).length;
  return { projects, issues, comments };
}

function reuApproveBar(d) {
  const { projects, issues, comments } = reuChosen(d);
  const parts = [projects ? plural(projects, 'proyecto', 'proyectos') : '', issues ? plural(issues, 'issue', 'issues') : '', comments ? plural(comments, 'comentario', 'comentarios') : ''].filter(Boolean);
  const what = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' y $1') : 'nada';
  const busy = S.reu.approving;
  return `<div class="reu-approve"><div class="sum">Crear <b>${esc(what)}</b><small>A tu nombre (${esc(S.snap?.me ?? '')}): los issues y los comentarios en GitHub con tu sesión${projects ? '; el proyecto en Linear con la key del repo' : ''}.</small></div>
    <button class="btn-s" data-reudiscard ${busy ? 'disabled' : ''}>Descartar ${Object.values(d.results).some((r) => r.ok) ? 'el resto' : 'todo'}</button>
    <button class="btn-s primary" data-reuapprove ${busy || !parts.length ? 'disabled' : ''}>${busy ? 'Creando…' : 'Crear seleccionados'}</button></div>`;
}

async function approveReunion(n) {
  const d = S.reu.detail[n]?.data;
  if (!d || S.reu.approving) return;
  const f = reuForm(d);
  const p = d.proposals;
  const ids = [...p.projects.flatMap((x) => [x.id, ...x.issues.map((i) => i.id)]), ...p.issues.map((i) => i.id), ...p.comments.map((c) => c.id)].filter((id) => f.on[id] && !d.results[id]?.ok);
  const items = ids.map((id) => ({ id, ...['title', 'body', 'lead', 'project', 'cycle'].reduce((o, k) => (f[k][id] !== undefined ? { ...o, [k]: f[k][id] } : o), {}) }));
  S.reu.approving = true;
  renderCenter();
  try {
    const out = await api(reuPath(n, '/aprobar'), { method: 'POST', body: JSON.stringify({ items }) });
    toast(out.failed ? `Se crearon ${out.created}; ${out.failed} no se pudieron crear: puedes intentarlo de nuevo.` : `Listo: se crearon ${out.created}.`);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo: ${error.message}`);
  }
  S.reu.approving = false;
  delete S.reu.form[n];
  await loadReunion(n);
}

async function discardReunion(n) {
  if (!confirm('¿Descartar lo que queda de esta reunión? No se crea nada más.')) return;
  try {
    await api(reuPath(n, '/descartar'), { method: 'POST', body: '{}' });
    toast('Listo: la reunión quedó descartada.');
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo: ${error.message}`);
  }
  await loadReunion(n);
}

// What each line of the notes is cited by.
function reuCitedBy(d) {
  const by = {};
  const add = (cites, label) => { for (const c of cites) (by[c] ??= new Set()).add(label); };
  const p = d.proposals;
  if (!p) return by;
  for (const x of p.projects) {
    add(x.cites, 'proyecto');
    for (const i of x.issues) add(i.cites, 'proyecto');
  }
  for (const i of p.issues) add(i.cites, 'issue');
  for (const c of p.comments) add(c.cites, `#${c.issue}`);
  for (const x of p.discarded) add(x.cites, 'descartado');
  return by;
}

function reuNotesHTML(d) {
  const file = d.original
    ? `<div class="reu-src"><span class="fi">${esc(d.source.kind === 'docx' ? 'DOCX' : d.source.kind === 'pdf' ? 'PDF' : 'TXT')}</span><div><span class="nm">${esc(d.source.name ?? '')}</span><small>${esc(reuSource(d))} · ${esc(reuChars(d.chars))}</small></div><a class="btn-s" href="${esc(reuPath(d.number, '/original'))}" download>Descargar original</a></div>`
    : `<p class="m pd-note">Pegadas en el tablero · ${esc(reuChars(d.chars))}.</p>`;
  const by = reuCitedBy(d);
  const lines = reuLines(d.text).map((line, i) => {
    const tags = by[i + 1];
    return `<div class="reu-line ${tags ? 'cited' : ''}" id="reu-l${i + 1}"><span class="n">${i + 1}</span><span class="t">${esc(line)}${tags ? `<span class="tags">${esc([...tags].join(', '))}</span>` : ''}</span></div>`;
  }).join('');
  return `${file}<div class="reu-notes">${lines}</div>`;
}

function reuActivityHTML(d) {
  const item = (cls, icon, title, at, extra = '') => `<li class="pd-ev ${cls}"><span class="ic">${PED_ICON[icon]}</span><div class="h"><b>${title}</b><span class="tm" title="${esc(when(at))}">${esc(hhmm(at))}</span></div>${extra}</li>`;
  const events = d.events.map((e) => {
    switch (e.kind) {
      case 'uploaded': return { at: e.at, html: item('person', 'person', `${esc(e.by)} subió las notas`, e.at) };
      case 'retried': return { at: e.at, html: item('person', 'person', `${esc(e.by)} pidió leerla de nuevo`, e.at) };
      case 'worker': return { at: e.at, html: item('small', 'wait', e.by === 'tick' ? 'El tick la vio sin worker y lanzó otro' : 'Lanzó el worker que la lee', e.at) };
      case 'read': return { at: e.at, html: item('ok', 'ok', `Propuso ${[e.projects ? plural(e.projects, 'proyecto', 'proyectos') : '', e.issues ? plural(e.issues, 'issue', 'issues') : '', e.comments ? plural(e.comments, 'comentario', 'comentarios') : ''].filter(Boolean).join(', ') || 'nada'}`, e.at, `<div class="m">${esc(plural(e.discarded, 'descartado', 'descartados'))}</div>`) };
      case 'failed': return { at: e.at, html: item('crit', 'crit', 'La lectura falló', e.at, `<div class="bx err">${esc(e.error)}</div>`) };
      case 'mail': return { at: e.at, html: item(e.ok ? 'small' : 'crit', 'mail', e.ok ? 'Correo al equipo del repo' : 'No salió el correo al equipo', e.at) };
      case 'approved': return { at: e.at, html: item(e.failed ? 'warn' : 'ok', e.failed ? 'crit' : 'ok', `${esc(e.by)} aprobó: ${esc(plural(e.created, 'creado', 'creados'))}${e.failed ? `, ${esc(plural(e.failed, 'no se pudo crear', 'no se pudieron crear'))}` : ''}`, e.at) };
      case 'discarded': return { at: e.at, html: item('small', 'person', `${esc(e.by)} descartó ${d.status === 'discarded' && Object.values(d.results).some((r) => r.ok) ? 'el resto' : 'la reunión'}`, e.at) };
      default: return null;
    }
  }).filter(Boolean);
  const runs = d.runs.map((run) => ({ at: run.startedAt, html: item('run', 'run', 'ronin leyó las notas', run.startedAt, pedRunCard(run)) }));
  return `<ol class="pd-tl">${[...events, ...runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((x) => x.html).join('')}</ol>`;
}

function reuRunsHTML(d) {
  if (!d.runs.length) return '<p class="note">Sin corridas en los últimos 14 días.</p>';
  const open = S.reu.run;
  const list = d.runs.map((run) => `<div class="pd-runrow ${open?.runId === run.runId ? 'cur' : ''}"><span class="tm">${esc(when(run.startedAt))}</span>${pedRunCard(run)}</div>`).join('');
  if (!open) return list;
  const body = open.summary
    ? `<div class="tx pd-tx">${open.lines.map(step).join('') || '<div class="empty">El agente todavía no hizo nada.</div>'}${ending(open.summary)}</div>`
    : `<div class="empty">${open.error ? esc(open.error) : 'Cargando la corrida…'}</div>`;
  return `<div class="pd-runview"><div class="pd-runbar"><b>${esc(typeName(open.summary?.taskType ?? ''))}</b><span class="m">${open.summary ? esc(when(open.summary.startedAt)) : ''}</span><button class="btn-s" data-prunx>Cerrar</button></div>${body}</div>${list}`;
}

function reuNowHTML(d) {
  const running = d.runs.find((run) => run.state === 'running');
  if (d.status === 'pending' || d.status === 'reading') {
    return `<div class="pd-now running"><div class="k">${dotClass('live')} Ahora · ${d.status === 'reading' ? 'ronin la está leyendo' : 'en cola para ronin'}</div>
      <div class="t">${d.status === 'reading' ? 'Lee las notas contra los issues abiertos, Linear y el código' : 'Espera un lugar libre para leerla'}</div>
      ${running ? `<div class="feed">${running.lastStep ? `▸ ${esc(running.lastStep)}` : 'Arrancando…'}</div><div class="acts"><button class="btn-s" data-prun="${esc(running.runId)}">Ver la corrida</button></div>` : '<div class="d">Suele tardar unos minutos. Al terminar, el equipo del repo recibe un correo si hay algo que revisar.</div>'}</div>`;
  }
  if (d.status === 'failed') {
    const last = d.events.filter((e) => e.kind === 'failed').at(-1);
    return `<div class="pd-now failed"><div class="k">${PED_ICON.crit} Ahora · falló la lectura</div><div class="t">ronin no pudo leer las notas</div>
      ${last ? `<div class="err">${esc(last.error)}</div>` : ''}<div class="acts"><button class="btn-s primary" data-reuretry ${S.reu.retrying ? 'disabled' : ''}>${S.reu.retrying ? 'Pidiendo…' : 'Leerla de nuevo'}</button></div></div>`;
  }
  if (d.status === 'empty') {
    return `<div class="pd-now"><div class="k">${PED_ICON.ok} Leída</div><div class="t">No salió trabajo nuevo de esta reunión</div><div class="d">ronin no propuso nada y no mandó correo. Lo que se habló está abajo, con el motivo.</div></div>`;
  }
  return '';
}

function reuSideHTML(d) {
  return `<div class="pd-side"><div class="pd-card"><h3>Reunión</h3><dl class="kv">
      ${d.at ? `<dt>Cuándo</dt><dd>${esc(when(d.at))}</dd>` : ''}
      <dt>Repo</dt><dd>${esc(d.repo)}</dd>
      <dt>Subida</dt><dd>${esc(d.by)}<small>${esc(when(d.createdAt))}</small></dd>
      <dt>Notas</dt><dd>${esc(reuSource(d))}<small>${esc(reuChars(d.chars))}</small></dd>
      ${d.link && /^https?:\/\//.test(d.link) ? `<dt>Link</dt><dd><a href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">${esc(d.link.replace(/^https?:\/\//, '').slice(0, 40))} ↗</a></dd>` : ''}
    </dl></div>
    ${d.runs.length ? `<div class="pd-card"><h3>Corridas</h3><div class="pd-costs">${d.runs.slice().reverse().map((run) => `<div><span>${esc(typeName(run.taskType))}</span><span>${run.costUsd !== undefined ? esc(money(run.costUsd)) : run.state === 'running' ? 'en curso' : '—'}</span></div>`).join('')}</div></div>` : ''}</div>`;
}

function reunionHTML() {
  const n = S.reu.n;
  const entry = S.reu.detail[n];
  const d = entry?.data;
  if (!d) return `<div class="today pd">${entry?.error ? `<p class="bad">${esc(entry.error)}</p>` : '<div class="empty">Cargando…</div>'}</div>`;
  const total = d.proposals ? d.proposals.projects.length + d.proposals.issues.length + d.proposals.comments.length : 0;
  const tabs = [...(d.proposals ? [['props', 'Propuestas', total]] : []), ['notas', 'Notas'], ['act', 'Actividad'], ['runs', 'Corridas', d.runs.length]];
  const tab = tabs.some(([k]) => k === S.reu.tab) ? S.reu.tab : tabs[0][0];
  const body = tab === 'props' ? reuProposalsHTML(d) : tab === 'act' ? reuActivityHTML(d) : tab === 'runs' ? reuRunsHTML(d) : reuNotesHTML(d);
  return `<div class="head pd-head"><div class="crumb"><button class="link" data-reupage>Reuniones</button> / <i style="background:${repoColor(d.repo)}"></i>${esc(repoShort(d.repo))}</div>
      <div class="row"><h1>${esc(d.title)} <span class="n">R-${d.number}</span></h1></div>
      <div class="state">${reuChip(d)}${d.at ? `<span>${esc(when(d.at))}</span>` : ''}<span class="m">subida por ${esc(d.by)} ${esc(ago(d.createdAt))}</span></div></div>
    <div class="doctabs" role="tablist">${tabs.map(([k, label, c]) => `<button class="doctab" role="tab" data-reutab="${k}" aria-selected="${tab === k}">${label}${c ? ` <span class="c">${c}</span>` : ''}</button>`).join('')}</div>
    <div class="pd-body"><div class="pd-cols"><div class="pd-main">${tab === 'runs' ? '' : reuNowHTML(d)}${body}</div>${reuSideHTML(d)}</div></div>`;
}

async function retryReunion(n) {
  S.reu.retrying = true;
  renderCenter();
  try {
    await api(reuPath(n, '/reintentar'), { method: 'POST', body: '{}' });
    toast(`Listo: ronin vuelve a leer R-${n}.`);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    toast(`No se pudo: ${error.message}`);
  }
  S.reu.retrying = false;
  await loadReunion(n);
}

function wireReuniones() {
  const center = $('#center');
  for (const row of center.querySelectorAll('[data-reu]')) {
    row.onclick = () => openReunion(Number(row.dataset.reu));
    row.onkeydown = (event) => { if (event.key === 'Enter') openReunion(Number(row.dataset.reu)); };
  }
  center.querySelector('[data-reunew]')?.addEventListener('click', openUpload);
  center.querySelector('[data-reupage]')?.addEventListener('click', openReuniones);
  center.querySelector('[data-reuretry]')?.addEventListener('click', () => retryReunion(S.reu.n));
  for (const b of center.querySelectorAll('[data-reutab]')) b.onclick = () => { S.reu.tab = b.dataset.reutab; renderCenter(); };
  for (const b of center.querySelectorAll('[data-reuopen]')) b.onclick = () => { S.reu.open[b.dataset.reuopen] = !S.reu.open[b.dataset.reuopen]; renderCenter(); };
  for (const b of center.querySelectorAll('[data-reuitem]')) b.onclick = () => select(b.dataset.reuitem);
  for (const b of center.querySelectorAll('[data-reuline]')) {
    b.onclick = () => {
      S.reu.tab = 'notas';
      renderCenter();
      const line = $(`#reu-l${b.dataset.reuline}`);
      if (line) {
        line.scrollIntoView({ block: 'center' });
        line.classList.add('flash');
        setTimeout(() => line.classList.remove('flash'), 1600);
      }
    };
  }
  for (const b of center.querySelectorAll('[data-prun]')) {
    b.onclick = () => {
      S.reu.tab = 'runs';
      S.reu.run = { runId: b.dataset.prun };
      renderCenter();
      $('#center .pd-body')?.scrollTo(0, 0);
      loadReunionRun(b.dataset.prun);
    };
  }
  center.querySelector('[data-prunx]')?.addEventListener('click', () => { S.reu.run = null; renderCenter(); });
  const d = S.reu.detail[S.reu.n]?.data;
  if (!d || S.page !== 'reunion') return;
  for (const b of center.querySelectorAll('[data-reuchk]')) {
    b.onchange = () => {
      const f = reuForm(d);
      f.on[b.dataset.reuchk] = b.checked;
      // A project's issues go with it.
      const project = d.proposals.projects.find((x) => x.id === b.dataset.reuchk);
      if (project) for (const i of project.issues) if (!d.results[i.id]?.ok) f.on[i.id] = b.checked;
      renderCenter();
    };
  }
  for (const el of center.querySelectorAll('[data-reuf]')) {
    const save = () => {
      const f = reuForm(d);
      f[el.dataset.reuf][el.dataset.reuid] = el.value;
      // Nothing is redrawn: the rest stays as typed, and a click on the bar
      // right after leaving a field still lands on its button.
      const fresh = document.createElement('div');
      fresh.innerHTML = reuApproveBar(d);
      const sum = center.querySelector('.reu-approve .sum');
      if (sum) sum.innerHTML = fresh.querySelector('.sum').innerHTML;
    };
    el.oninput = save;
    el.onchange = save;
  }
  center.querySelector('[data-reuapprove]')?.addEventListener('click', () => approveReunion(S.reu.n));
  center.querySelector('[data-reudiscard]')?.addEventListener('click', () => discardReunion(S.reu.n));
}

// The upload dialog: a file, or the text pasted.
function openUpload() {
  const repos = S.snap?.repos ?? [];
  S.reu.up = { repo: repos[0] ?? '', title: '', at: '', link: '', text: '', file: null, sending: false, error: null };
  renderUpload();
}

function closeUpload() {
  if (S.reu.up?.sending) return;
  S.reu.up = null;
  renderUpload();
}

const kb = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

function takeFile(file) {
  const u = S.reu.up;
  if (!u || !file) return;
  u.error = null;
  if (file.size > REU_MAX_BYTES) {
    u.error = 'El archivo puede pesar hasta 10 MB.';
    renderUpload();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    u.file = { name: file.name, size: file.size, data: reader.result };
    renderUpload();
  };
  reader.onerror = () => {
    u.error = 'No se pudo leer el archivo.';
    renderUpload();
  };
  reader.readAsDataURL(file);
}

function renderUpload() {
  let layer = $('#rlayer');
  const u = S.reu.up;
  if (!u) {
    layer?.remove();
    return;
  }
  if (!layer) {
    const repos = S.snap?.repos ?? [];
    layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'rlayer' });
    layer.innerHTML = `<div class="scrim"><div class="dlg dlg-new" role="dialog" aria-modal="true" aria-labelledby="ru-t">
      <h2 id="ru-t">Subir notas de una reunión</h2>
      <p class="help">ronin propone; nada se crea hasta que alguien lo apruebe. Las notas quedan en el runner, nunca en GitHub.</p>
      <div class="reu-row2"><label class="field"><span>Repo</span><select id="ru-repo">${repos.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
        <label class="field"><span>Fecha (opcional)</span><input id="ru-at" type="datetime-local"></label></div>
      <label class="field"><span>Título (opcional)</span><input id="ru-title" maxlength="120" autocomplete="off" placeholder="Si lo dejas vacío, sale del archivo o de las notas"></label>
      <div id="ru-file"></div>
      <input id="ru-input" type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" hidden>
      <div id="ru-paste"><div class="reu-or">o pega el texto</div>
        <label class="field"><span class="sr">Texto de las notas</span><textarea id="ru-text" rows="6" placeholder="Las notas tal como están…"></textarea></label></div>
      <label class="field"><span>Link de la reunión o la grabación (opcional)</span><input id="ru-link" maxlength="500" autocomplete="off" placeholder="https://meet.google.com/…"></label>
      <p class="bad" id="ru-err" hidden></p>
      <div class="foot-d"><button class="btn-s" id="ru-no">Cancelar</button><button class="btn-s primary" id="ru-yes">Subir</button></div></div></div>`;
    const bind = (sel, key) => { $(sel).oninput = (e) => { S.reu.up[key] = e.target.value; renderUpload(); }; };
    bind('#ru-title', 'title');
    bind('#ru-at', 'at');
    bind('#ru-link', 'link');
    bind('#ru-text', 'text');
    $('#ru-repo').onchange = (e) => { S.reu.up.repo = e.target.value; };
    $('#ru-input').onchange = (e) => takeFile(e.target.files[0]);
    $('#ru-no').onclick = closeUpload;
    $('#ru-yes').onclick = sendUpload;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeUpload(); };
    $('#ru-repo').focus();
  }
  const box = $('#ru-file');
  const html = u.file
    ? `<div class="reu-drop has"><span class="fi">${esc((u.file.name.split('.').pop() ?? '').toUpperCase().slice(0, 4))}</span><div><span class="nm">${esc(u.file.name)}</span><small>${esc(kb(u.file.size))}</small></div><button class="btn-s" id="ru-rm">Quitar</button></div>`
    : `<button class="reu-drop" id="ru-pick"><b>Arrastra el archivo aquí o elígelo</b><span>PDF, Word (.docx), texto o Markdown · hasta 10 MB</span><small>De Google Docs: Archivo → Descargar → PDF o .docx</small></button>`;
  if (box._html !== html) {
    box._html = html;
    box.innerHTML = html;
    $('#ru-rm')?.addEventListener('click', () => { u.file = null; $('#ru-input').value = ''; renderUpload(); });
    const pick = $('#ru-pick');
    if (pick) {
      pick.onclick = () => $('#ru-input').click();
      pick.ondragover = (e) => { e.preventDefault(); pick.classList.add('over'); };
      pick.ondragleave = () => pick.classList.remove('over');
      pick.ondrop = (e) => { e.preventDefault(); pick.classList.remove('over'); takeFile(e.dataTransfer.files[0]); };
    }
  }
  $('#ru-paste').hidden = Boolean(u.file);
  const yes = $('#ru-yes');
  yes.textContent = u.sending ? 'Subiendo…' : 'Subir';
  yes.disabled = u.sending || !u.repo || (!u.file && !u.text.trim());
  $('#ru-err').hidden = !u.error;
  $('#ru-err').innerHTML = u.error ?? '';
}

async function sendUpload() {
  const u = S.reu.up;
  if (!u || u.sending) return;
  u.sending = true;
  u.error = null;
  renderUpload();
  try {
    const body = { repo: u.repo, title: u.title, link: u.link, ...(u.at ? { at: new Date(u.at).toISOString() } : {}), ...(u.file ? { file: { name: u.file.name, data: u.file.data } } : { text: u.text }) };
    const response = await fetch('/api/reuniones', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status === 401) throw new Unauthorized();
    const out = await response.json().catch(() => ({}));
    if (!response.ok) {
      u.sending = false;
      // The same notes again: a way to the meeting that has them.
      u.error = response.status === 409 && out.number
        ? `${esc(out.error)} <button class="link" data-reugo="${Number(out.number)}">Abrir R-${Number(out.number)}</button>`
        : esc(`No se pudo: ${out.error ?? response.status}`);
      renderUpload();
      $('#rlayer [data-reugo]')?.addEventListener('click', (e) => { S.reu.up = null; renderUpload(); openReunion(Number(e.target.dataset.reugo)); });
      return;
    }
    S.reu.up = null;
    renderUpload();
    toast(`Listo: subiste las notas como R-${out.number}.`);
    refresh();
    openReunion(out.number);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    u.sending = false;
    u.error = esc(`No se pudo: ${error.message}`);
    renderUpload();
  }
}

// ---------- context
function linearCtxHTML(item) {
  const l = item.linear;
  if (!l) return '';
  const current = l.cycle?.current ? currentCycleOf(item.repo) : null;
  return `<section><h3>${LIN_ICON} Linear</h3><dl class="kv">
    <dt>Issue</dt><dd>${safeLinear(l.url) ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.id)} ↗</a>` : esc(l.id)}</dd>
    <dt>Estado</dt><dd>${esc(l.state.name)}</dd>
    <dt>Proyecto</dt><dd>${l.project ? esc(l.project.name) : '—'}</dd>
    <dt>Ciclo</dt><dd>${l.cycle ? `${esc(cycleName(l.cycle))}${current ? `, termina el ${esc(endDay(current.endsAt))}` : ''}` : '—'}</dd>
    ${l.assignee ? `<dt>Asignado</dt><dd>${esc(l.assignee)}</dd>` : ''}</dl>
    ${l.cycle?.current && item.kind === 'issue' ? '<p class="note">Es del ciclo actual: si no alcanzan los lugares para agentes, ronin lo toma antes que los demás.</p>' : ''}</section>`;
}

function ctxHTML(item) {
  const runs = itemRuns(item);
  let html = linearCtxHTML(item);
  if (item.status === 'blocked') {
    html += `<section><h3>Por qué está bloqueado</h3><div class="why">${item.block
      ? `<b>Hace ${esc(short(Date.now() - Date.parse(item.block.at)))}.</b> ${esc(item.block.reason)}${item.block.excerpt ? `<span class="ask">${esc(item.block.excerpt)}</span>` : ''}`
      : 'ronin no guardó el motivo en este runner (puede ser de antes del tablero): está en el email del bloqueo.'}
      <span class="ask">Cuando esté resuelto, volvé a ponerle <code>ronin:in-progress</code> al issue.</span></div></section>`;
  }
  if (item.slices?.length) {
    const merged = item.slices.filter((s) => s.status === 'merged').length;
    html += `<section class="orch"><h3>Slices</h3><div class="parent">${dot(item.status)}<span>#${esc(item.number)}</span><small>${merged} de ${item.slices.length} ${item.slices.length === 1 ? 'mergeada' : 'mergeadas'}</small></div>
      <div class="kidsx">${item.slices.map((slice) => {
        const [cls, text] = SLICE_STATE[slice.status];
        const link = slice.prNumber ? prUrl(item.repo, slice.prNumber) : null;
        const detail = slice.status === 'open' ? [slice.checks && slice.checks !== 'none' ? `checks: ${CHECK_STATE[slice.checks][1]}` : null, slice.reviewDecision === 'APPROVED' ? 'aprobada' : slice.reviewDecision === 'CHANGES_REQUESTED' ? 'cambios pedidos' : null].filter(Boolean).join(', ') : '';
        return `<div class="sl ${slice.status === 'pending' ? 'pending' : ''}">${sliceMark(slice)}<span>${slice.index + 1}. ${esc(slice.title)}</span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">#${esc(slice.prNumber)}</a>` : '<span></span>'}<small>${esc(text)}${detail ? `, ${esc(detail)}` : ''}</small></div>`;
      }).join('')}</div></section>`;
  }
  if (item.pr?.checks?.length) {
    html += `<section><h3>Checks de #${esc(item.pr.number)}</h3><ul class="checks">${item.pr.checks.map((check) => `<li>${dotClass(CHECK_STATE[check.outcome][0])}<span>${esc(check.name)}</span><span class="m">${esc(CHECK_STATE[check.outcome][1])}</span></li>`).join('')}</ul></section>`;
  }
  if (item.preview) html += previewHTML(item.preview);
  if (runs.length === 0) return html;
  const shown = runs[Math.min(S.runIdx[item.id] ?? 0, runs.length - 1)];
  const cost = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const failed = runs.filter((run) => ['error', 'timeout', 'cut'].includes(run.state)).length;
  html += `<section><h3>Esta corrida</h3><dl class="kv">
    <dt>Tarea</dt><dd>${esc(typeName(shown.taskType))}${shown.sliceIndex !== undefined ? `, slice ${shown.sliceIndex + 1}` : ''}</dd>
    ${shown.model ? `<dt>Modelo</dt><dd>${esc(shown.model)}${shown.effort ? `, ${esc(shown.effort)}` : ''}</dd>` : ''}
    <dt>Cuenta</dt><dd>${esc(shown.account)}</dd>
    <dt>Empezó</dt><dd>${esc(new Date(shown.startedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }))}</dd>
    ${shown.durationMs !== undefined ? `<dt>Duró</dt><dd>${esc(duration(shown.durationMs))}</dd>` : ''}
    ${shown.costUsd !== undefined ? `<dt>Costo</dt><dd>${esc(money(shown.costUsd))}</dd>` : ''}
    <dt>Worktree</dt><dd class="mono" style="font-size:12px">${esc(shown.worktree)}</dd></dl></section>`;
  html += `<section><h3>Últimos 14 días</h3><dl class="kv"><dt>Corridas</dt><dd>${runs.length}${failed ? `, ${failed} con error` : ''}</dd>${cost ? `<dt>Costo</dt><dd>${esc(money(cost))}</dd>` : ''}</dl></section>`;
  return html;
}

// While its test data is being prepared, the preview is up but not ready to
// try: the URL is shown as such, not as a link to open yet.
function previewHTML(preview) {
  const left = preview.expiresAt ? Date.parse(preview.expiresAt) - Date.now() : null;
  const safe = /^https?:\/\//.test(preview.url);
  const host = esc(preview.url.replace(/^https?:\/\//, ''));
  return `<section><h3>Preview</h3><div class="pv">${esc(preview.appName)} con #${esc(preview.prNumber)}</div>
    ${preview.preparing
      ? `<div class="pv-prep">${dotClass('live')}<span>Preparando los datos para probar el PR. La URL queda lista cuando termine.</span></div>${safe ? `<span class="url off">${host}</span>` : ''}`
      : safe ? `<a class="url" href="${esc(preview.url)}" target="_blank" rel="noopener">${host}</a>` : ''}
    ${left !== null ? `<dl class="kv" style="margin-top:8px"><dt>Se baja en</dt><dd data-until="${esc(preview.expiresAt)}">${esc(clock(left))}</dd></dl><div class="ttl"><span style="width:${Math.max(0, Math.min(100, (left / (60 * MIN)) * 100))}%"></span></div>` : ''}
    <p class="note">Los usuarios de prueba están en el comentario de la preview, en el PR.</p></section>`;
}

// What this session sees and why (#106): everything as an admin, or the
// repos GitHub says it can at least triage.
const PERMISSION = { triage: 'triage', push: 'escritura', maintain: 'maintain', admin: 'admin' };
function accessHTML() {
  const access = S.snap.access;
  if (!access) return '';
  if (access.admin) return `<section><h3>Tu acceso</h3><p class="note" style="margin:0">Sos administrador del tablero: ves todos los repos.</p></section>`;
  return `<section><h3>Tu acceso</h3><dl class="kv">${access.repos.map((r) => `<dt><span class="repo-tag"><i style="background:${repoColor(r.repo)}"></i>${esc(repoShort(r.repo))}</span></dt><dd>${esc(PERMISSION[r.permission] ?? r.permission)} en GitHub</dd>`).join('')}</dl>
    <p class="note">Ves los repos en los que podés gestionar issues (triage o más) en GitHub. Se vuelve a consultar cada 10 minutos: si te dan o te sacan acceso, el tablero lo sigue.</p></section>`;
}

function renderCtx() {
  const item = S.sel && itemById(S.sel);
  if (item) {
    $('#ctx').innerHTML = ctxHTML(item);
    return;
  }
  const { tick, slots } = S.snap.runner;
  $('#ctx').innerHTML = `${accessHTML()}<section><h3>Runner</h3><dl class="kv">
    <dt>Agentes</dt><dd>${slots.used} de ${slots.limit} lugares ocupados</dd>
    <dt>Último tick</dt><dd>${tick.lastTickAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastTickAt)))}, duró ${esc(duration(tick.lastTickDurationMs ?? 0))}` : 'sin datos hoy'}</dd>
    <dt>Último evento</dt><dd>${tick.lastEventAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastEventAt)))}` : 'sin datos hoy'}</dd>
    <dt>Repos</dt><dd>${S.snap.repos.map((repo) => `<span class="repo-tag"><i style="background:${repoColor(repo)}"></i>${esc(repo)}</span>`).join('<br>')}</dd></dl></section>
    <section><h3>Previews arriba</h3>${S.snap.previews.length ? S.snap.previews.map((p) => `<div class="pv-row"><div>${esc(p.appName)} con #${esc(p.prNumber)} <span class="m">${esc(repoShort(p.repo))}${p.preparing ? ', preparando datos' : ''}</span></div>${/^https?:\/\//.test(p.url) ? (p.preparing ? `<span class="url off">${esc(p.url.replace(/^https?:\/\//, ''))}</span>` : `<a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ''))}</a>`) : ''}</div>`).join('') : '<p class="note">Ninguna.</p>'}</section>
    ${linearRepos().map((l) => `<section><h3>${LIN_ICON} Linear · ${esc(repoShort(l.repo))}</h3><dl class="kv">
      ${l.workspace ? `<dt>Workspace</dt><dd>${esc(l.workspace)}${l.cycle ? ` (equipo ${esc(l.cycle.team)})` : ''}</dd>` : ''}
      <dt>Ciclo actual</dt><dd>${l.cycle ? `${esc(cycleName(l.cycle))}, ${esc(dayMonth(l.cycle.startsAt))} – ${esc(endDay(l.cycle.endsAt))}` : 'ninguno'}</dd>
      <dt>Leído</dt><dd>${l.error ? `<span class="bad">no se pudo leer: ${esc(l.error)}</span>` : l.fetchedAt ? `hace ${esc(short(Date.now() - Date.parse(l.fetchedAt)))}` : 'sin leer'}</dd></dl></section>`).join('')}
    <section><h3>GitHub</h3><dl class="kv">${S.snap.github.map((g) => `<dt>${esc(repoShort(g.repo))}</dt><dd>${g.error ? `<span class="bad">no se pudo leer: ${esc(g.error)}</span>${g.fetchedAt ? `, datos de hace ${esc(short(Date.now() - Date.parse(g.fetchedAt)))}` : ''}` : g.fetchedAt ? `leído hace ${esc(short(Date.now() - Date.parse(g.fetchedAt)))}` : 'sin leer'}</dd>`).join('')}</dl></section>`;
}

// ---------- status bar
function usageMeter(usage) {
  const now = Date.now();
  const out = usage.limitHitAt && usage.fiveHour && Date.parse(usage.fiveHour.resetsAt) > now;
  const fresh = (window) => window && Date.parse(window.resetsAt) > now;
  const five = fresh(usage.fiveHour) ? usage.fiveHour.utilization : null;
  const week = fresh(usage.sevenDay) ? usage.sevenDay.utilization : null;
  const title = `Cuenta ${usage.account}, medido hace ${short(now - Date.parse(usage.measuredAt))}` +
    (usage.fiveHour ? `. La ventana de 5 h se reinicia a las ${hhmm(usage.fiveHour.resetsAt)}` : '') +
    (usage.sevenDay ? `, la semanal el ${new Date(usage.sevenDay.resetsAt).toLocaleDateString('es', { weekday: 'long' })}` : '');
  const value = out ? `sin cuota hasta ${hhmm(usage.fiveHour.resetsAt)}` : five === null ? 'se reinició' : `${pct(five)} 5h`;
  return `<span class="meter${out ? ' out' : ''}" title="${esc(title)}">${esc(usage.account)}<span class="m"><span class="${five !== null && five >= 0.75 ? 'hot' : ''}" style="width:${five === null ? 0 : Math.min(100, five * 100)}%"></span></span><b>${esc(value)}</b>${week !== null ? `<span class="hide-m">${pct(week)} sem</span>` : ''}</span>`;
}

function renderStatus() {
  const { slots, queue, tick } = S.snap.runner;
  const tickAge = tick.lastTickAt ? Date.now() - Date.parse(tick.lastTickAt) : null;
  const dark = document.documentElement.dataset.theme !== 'light';
  $('#statusbar').innerHTML = S.snap.usage.map(usageMeter).join('') +
    `<span class="sp hide-m">agentes ${slots.used}/${slots.limit}</span>` +
    `<span class="hide-m">en cola ${queue.length}</span>` +
    `<span class="hide-m">previews ${S.snap.previews.length}</span>` +
    (S.snap.github.some((g) => g.error) ? `<span class="hide-m bad" title="${esc(S.snap.github.filter((g) => g.error).map((g) => `${g.repo}: ${g.error}`).join('; '))}">GitHub sin responder</span>` : '') +
    `<span class="hide-m"><span class="ok-dot${tickAge === null || tickAge > 45 * MIN ? ' stale' : ''}"></span>${tickAge === null ? 'sin tick hoy' : `tick hace ${esc(short(tickAge))}`}</span>` +
    `<span class="hide-m">${esc(S.snap.me)}</span>` +
    `<button id="theme">${dark ? 'Tema claro' : 'Tema oscuro'}</button><button id="logout">Salir</button>`;
  $('#theme').onclick = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ronin-theme', next); } catch { /* sin storage */ }
    renderStatus();
  };
  $('#logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  };
}

function renderAll() {
  renderQuick();
  renderTree();
  renderCenter();
  renderCtx();
  renderStatus();
}

// ---------- data
function stopStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

async function loadShownRun() {
  const item = itemById(S.sel);
  if (!item) return;
  const runs = S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
  stopStream();
  if (runs.length === 0) {
    S.run = null;
    renderCenter();
    renderCtx();
    return;
  }
  const shown = runs[Math.min(S.runIdx[item.id] ?? 0, runs.length - 1)];
  S.run = null;
  renderCenter();
  renderCtx();
  try {
    const { summary, lines } = await api(`/api/runs/${encodeURIComponent(shown.runId)}`);
    const steps = lines.filter((line) => line.type !== 'run_start' && line.type !== 'run_end');
    S.run = { runId: shown.runId, summary, lines: steps, count: lines.length };
    renderCenter();
    if (summary.state === 'running') follow(shown.runId, lines.length);
  } catch (error) {
    if (error instanceof Unauthorized) showLogin();
  }
}

// The run still going: its new lines as they're written.
function follow(runId, from) {
  const stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?from=${from}`);
  S.stream = stream;
  stream.onmessage = (event) => {
    if (!S.run || S.run.runId !== runId) return;
    const line = JSON.parse(event.data);
    if (line.type === 'run_end') return;
    S.run.lines.push(line);
    renderCenter();
  };
  stream.addEventListener('end', () => {
    stopStream();
    refresh().then(() => loadItem(S.sel));
  });
  stream.onerror = () => stopStream();
}

async function loadItem(id) {
  if (!id) return;
  try {
    const { runs } = await api(`/api/items/${encodeURIComponent(id)}`);
    S.itemRuns[id] = runs;
    if (S.pendingRun) {
      const index = runs.findIndex((run) => run.runId === S.pendingRun);
      // A run picked on Hoy's timeline opens as its transcript.
      if (index >= 0) {
        S.runIdx[id] = index;
        S.view[id] = 'tx';
      }
      S.pendingRun = null;
    }
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
  }
  if (S.sel === id) await loadShownRun();
}

// The item's issue and PR from GitHub. The server caches them, so asking
// again only costs a call to GitHub once its copy is old.
async function loadDetail(id) {
  const item = itemById(id);
  const entry = (S.detail[id] ??= {});
  if (!item || item.kind === 'other' || entry.loading) return;
  entry.loading = true;
  try {
    entry.data = await api(`/api/items/${encodeURIComponent(id)}/detail`);
    entry.error = null;
    const extra = S.extra[id];
    const doc = extra && (entry.data.ref?.kind === 'pr' ? entry.data.pr : entry.data.issue);
    if (doc) Object.assign(extra, { kind: entry.data.ref.kind, title: doc.title, url: doc.url, status: doc.state === 'OPEN' ? 'open' : 'ok' });
    if (entry.data.exploration) loadExploration(id);
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  if (S.sel === id) renderCenter();
}

async function select(id) {
  // A meeting's run opens the meeting's page, on that run (#62).
  const reu = /:meeting-read:reunión R-(\d+)/.exec(id);
  if (reu) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openReunion(Number(reu[1]));
    if (runId) {
      S.reu.tab = 'runs';
      S.reu.run = { runId };
      loadReunionRun(runId);
    }
    return;
  }
  // A portal request's run (Hoy's timeline) opens the request's page, on that run (#132).
  const ped = /:portal-(?:request|prototype):pedido P-(\d+)/.exec(id);
  if (ped) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openPedido(Number(ped[1]));
    if (runId) {
      S.ped.tab = 'runs';
      S.ped.run = { runId };
      loadPedidoRun(runId);
    }
    return;
  }
  const n = /^(.+)#(\d+)$/.exec(id);
  if (!itemById(id) && n) S.extra[id] = { id, repo: n[1], number: Number(n[2]), kind: 'issue', title: `#${n[2]}`, status: 'open', runs: 0, listed: false };
  S.sel = id;
  S.page = null;
  S.runIdx[id] = 0;
  delete S.view[id];
  S.menu = false;
  if (!S.open.includes(id)) S.open.push(id);
  const path = `/i/${encodeURIComponent(id)}`;
  if (location.pathname !== path) history.pushState(null, '', S.ficha[id] ? `${path}?f=${encodeURIComponent(S.ficha[id])}` : path);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadDetail(id);
  await loadItem(id);
}

async function refresh() {
  try {
    [S.snap, S.today] = await Promise.all([api('/api/snapshot'), S.sel ? Promise.resolve(S.today) : api('/api/today')]);
  } catch (error) {
    if (error instanceof Unauthorized) showLogin();
    return;
  }
  renderQuick();
  renderTree();
  renderCtx();
  renderStatus();
  await followNewRun();
  renderCenter();
  const detail = S.sel && S.detail[S.sel];
  if (detail && Date.now() - (detail.at ?? 0) > DETAIL_EVERY_MS) loadDetail(S.sel);
  else {
    const expl = S.sel && S.expl[S.sel];
    // While a finding waits on ronin, its answer is looked for more often.
    const waiting = expl?.data?.fichas.some((f) => fichaStatus(f, expl.data.ronin) === 'esperando');
    if (expl && Date.now() - (expl.at ?? 0) > (waiting ? WAITING_EVERY_MS : DETAIL_EVERY_MS)) loadExploration(S.sel);
  }
  if (S.page === 'pedido' && Date.now() - (S.ped.detail[S.ped.n]?.at ?? 0) > PEDIDO_EVERY_MS) loadPedido(S.ped.n);
  if (S.page === 'pedidos' && Date.now() - S.ped.listAt > PEDIDO_EVERY_MS) loadPedidos();
  if (S.page === 'reunion' && Date.now() - (S.reu.detail[S.reu.n]?.at ?? 0) > PEDIDO_EVERY_MS) loadReunion(S.reu.n);
  if (S.page === 'reuniones' && Date.now() - S.reu.listAt > PEDIDO_EVERY_MS) loadReuniones();
  const item = S.sel && itemById(S.sel);
  const files = S.sel && S.files[S.sel];
  if (item && files && docOf(item) === 'files' && Date.now() - (files.at ?? 0) > DETAIL_EVERY_MS) loadFiles(S.sel);
}

// A new run on the open item: its list of runs is read again. Whoever was
// looking at the latest one moves on to the new one (and follows it live);
// whoever was looking at an older one stays on it.
async function followNewRun() {
  const item = S.sel && itemById(S.sel);
  const known = S.sel && S.itemRuns[S.sel];
  if (!item?.lastRun || !known || known.some((run) => run.runId === item.lastRun.runId)) return;
  const id = S.sel;
  const index = S.runIdx[id] ?? 0;
  const viewing = known[index]?.runId;
  let runs;
  try {
    ({ runs } = await api(`/api/items/${encodeURIComponent(id)}`));
  } catch (error) {
    if (error instanceof Unauthorized) showLogin();
    return;
  }
  if (S.sel !== id) return;
  S.itemRuns[id] = runs;
  if (index === 0) {
    S.runIdx[id] = 0;
    await loadShownRun();
  } else {
    S.runIdx[id] = Math.max(0, runs.findIndex((run) => run.runId === viewing));
  }
}

function tickClocks() {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = clock(Date.now() - Date.parse(el.dataset.since));
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = clock(Date.parse(el.dataset.until) - Date.now());
}

// /pedidos, /pedidos/<n> (#132), /portal (the accounts, admins only),
// /reuniones and /reuniones/<n> (#62): false for any other path.
function openPortalPath() {
  const n = /^\/pedidos\/(\d+)$/.exec(location.pathname)?.[1];
  const r = /^\/reuniones\/(\d+)$/.exec(location.pathname)?.[1];
  if (r) openReunion(Number(r));
  else if (location.pathname === '/reuniones') openReuniones();
  else if (n) openPedido(Number(n));
  else if (location.pathname === '/pedidos') openPedidos();
  else if (location.pathname === '/portal' && S.snap.portalAdmin) openPortal();
  else return false;
  return true;
}

function selectedFromPath() {
  const match = /^\/i\/(.+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

async function boot() {
  // A screenshot that didn't load (md) goes back to being a label.
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (img instanceof HTMLImageElement && img.classList.contains('ev')) img.replaceWith(img.dataset.label ?? '[imagen]');
  }, true);
  try {
    await api('/api/auth/me');
  } catch {
    showLogin();
    return;
  }
  await refresh();
  if (!S.snap) return;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  // Open from the start: whatever is running right now.
  S.open = S.snap.items.filter((item) => item.status === 'running').map((item) => item.id);
  const fromPath = selectedFromPath();
  const ficha = new URLSearchParams(location.search).get('f');
  if (fromPath && ficha) {
    S.ficha[fromPath] = ficha;
    S.fichaOpen[fromPath] = true;
  }
  if (fromPath) await select(fromPath);
  else if (!openPortalPath()) renderAll();

  document.addEventListener('click', (event) => {
    // A click outside the review panel closes it, as Escape does; one that
    // re-rendered the panel (a radio, say) leaves its target detached.
    if (S.rpanel && !S.rpanel.sending && event.target.isConnected && !event.target.closest('.rpanel')) {
      S.rpanel = null;
      S.menu = false;
      S.fmenu = false;
      renderCenter();
      return;
    }
    if (!S.menu && !S.fmenu) return;
    S.menu = false;
    S.fmenu = false;
    renderCenter();
  });
  document.addEventListener('keydown', (event) => {
    if (S.lightbox) {
      const f = S.expl[S.lightbox.item]?.data?.fichas.find((x) => fichaKey(x) === S.lightbox.ficha);
      if (event.key === 'Escape') S.lightbox = null;
      else if (event.key === 'ArrowRight' && f && S.lightbox.antes < f.antes.length - 1) S.lightbox.antes++;
      else if (event.key === 'ArrowLeft' && S.lightbox.antes > 0) S.lightbox.antes--;
      else return;
      renderLightbox();
      return;
    }
    // On an exploration PR's findings, as long as nothing is being typed:
    // j/k go through them, a marks one as looked at, c and r open the dialog.
    const item = S.sel && itemById(S.sel);
    const reviewing = !S.dialog && !S.fdialog && !S.newIssue && !event.metaKey && !event.ctrlKey && !event.altKey && item && viewOf(item) === 'ficha' && docOf(item) === 'fichas' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    // On a PR's files, j/k go from one file to the next (#111).
    const typing = event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (!typing && !S.dialog && !S.fdialog && !S.newIssue && item && viewOf(item) === 'ficha' && docOf(item) === 'files' && ['j', 'k', 'v', 'r'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'r') openReviewPanel();
      else if (event.key === 'v') toggleViewedCurrent();
      else moveFile(event.key === 'j' ? 1 : -1);
      return;
    }
    if (reviewing && ['j', 'k', 'a', 'c', 'r'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'j' || event.key === 'k') moveFicha(event.key === 'j' ? 1 : -1);
      else if (event.key === 'a') toggleLista();
      else if (document.querySelector(`[data-fact="${event.key === 'c' ? 'cambios' : 'rechazar'}"]`)) openFichaAction(event.key === 'c' ? 'cambios' : 'rechazar');
      return;
    }
    if (event.key !== 'Escape') return;
    if (S.ped.lb) {
      S.ped.lb = null;
      pedLightbox();
    } else if (S.pdialog) closePortalUser();
    else if (S.newIssue) closeNewIssue();
    else if (S.rpanel && !S.rpanel.sending) {
      S.rpanel = null;
      renderCenter();
    } else if (S.fcomp && !S.fcomp.sending) {
      S.fcomp = null;
      renderCenter();
    }
    else if (S.fdialog) closeFichaDialog();
    else if (S.fmenu) {
      S.fmenu = false;
      renderCenter();
    } else if (S.dialog) closeDialog();
    else if (S.menu) {
      S.menu = false;
      renderCenter();
    }
  });
  $('#q').oninput = (event) => {
    S.q = event.target.value;
    renderTree();
  };
  addEventListener('popstate', () => {
    const id = selectedFromPath();
    if (id) select(id);
    else if (openPortalPath()) return;
    else {
      S.page = null;
      S.sel = null;
      stopStream();
      renderAll();
    }
  });
  setInterval(() => {
    if (!document.hidden) refresh();
  }, SNAPSHOT_EVERY_MS);
  setInterval(tickClocks, 1000);
}

boot();
