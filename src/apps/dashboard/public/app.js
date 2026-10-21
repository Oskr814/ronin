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
  'plan': 'Planificar', 'implement-slice': 'Implementar slice', 'fix-issue': 'Resolver issue', 'fix-review': 'Responder review',
  'fix-e2e': 'Arreglar e2e', 'review-request': 'Pedido en review', 'fix-comments': 'Aplicar comentarios',
  'fix-comments-external': 'Aplicar comentarios', 'resolve-conflicts': 'Resolver conflictos', 'thread-reply-external': 'Responder hilo',
  'external-review': 'Review externa', 'spike': 'Spike', 'write-spec': 'Escribir spec', 'revise-spec': 'Conversar el spec', 'issue-request': 'Pedido en issue',
  'prototype': 'Prototipo', 'update-changelog': 'Changelog', 'explore-inventory': 'Inventario de exploración',
  'explore-function': 'Explorar', 'explore-evaluate': 'Evaluar exploración', 'explore-redo-after': 'Rehacer captura',
  'explore-feedback': 'Comentarios de exploración', 'commit-subject': 'Mensaje de commit', 'prepare-preview-data': 'Datos de preview', 'preview-seed-catalog': 'Catálogo de seeds', 'preview-data-triage': 'Revisión de los seeds', 'preview-data-delta': 'Datos de preview al actualizarse', 'portal-request': 'Pedido del portal', 'portal-interview': 'Respuestas de la entrevista', 'portal-prototype': 'Prototipo del portal', 'portal-reproduce': 'Reproducción del portal', 'meeting-read': 'Lectura de reunión',
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
// Runs that are steps of one thing (platform/agents/run-group.ts): a preview's seed
// catalog, "¿alcanzan los seeds?" and its data are one preview.
const GROUP_NAME = { preview: 'Preview' };
const groupName = (run) => (run?.group ? GROUP_NAME[run.group.split(':')[0]] : undefined);
// What a run is: its group's name, or its own task's.
const runKind = (run) => groupName(run) ?? typeName(run.taskType);
// A step of a group says which one: "Preview: Revisión de los seeds".
const runTitle = (run) => (groupName(run) ? `${groupName(run)}: ${typeName(run.taskType)}` : typeName(run.taskType));
const dot = (state) => `<span class="dot ${(STATE[state] ?? STATE.error)[0]}" aria-hidden="true"></span>`;
const dotClass = (cls) => `<span class="dot ${cls}" aria-hidden="true"></span>`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const isMobile = () => matchMedia('(max-width: 760px)').matches;
// What the session can do in a repo (#174): the server says it per repo; an
// admin does everything. The server refuses anyway, this only hides it.
function canDo(repo, perm) {
  if (S.snap?.access.admin) return true;
  const entry = S.snap?.access.repos.find((r) => r.repo === repo);
  if (!entry) return false;
  return entry.perms ? entry.perms[perm] : perm !== 'desplegar';
}

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

const S = { snap: null, today: null, sel: null, open: [], runIdx: {}, pendingRun: null, filter: null, q: '', itemRuns: {}, run: null, stream: null, detail: {}, view: {}, doc: {}, menu: false, dialog: null, expanded: new Set(), expl: {}, ficha: {}, fichaOpen: {}, fichaFilter: { tipo: 'todas', vp: 'todos' }, antes: {}, oldAfter: new Set(), lightbox: null, fmenu: false, fdialog: null, fdraft: {}, listas: {}, scope: 'all', project: '', extra: {}, newIssue: null, files: {}, fcur: {}, ffold: {}, fexp: {}, fcontent: {}, fq: {}, ftree: false, fcomp: null, fbusy: new Set(), rpanel: null, revSent: {}, decide: null, decided: {}, kunit: null, page: null, ped: { n: null, run: null }, reu: { n: null, run: null }, xpl: { list: null, error: null, listAt: 0, repo: null, app: null, cor: {}, inv: {}, tab: 'corridas', run: null, launched: {} }, xnow: null, dep: { list: null }, mt: { tab: 'trabajo' }, aj: { sec: 'perfil', login: null, repo: null, cuenta: null, f: null } };
// The sidebar's Linear filter (#101), remembered per browser.
try { Object.assign(S, JSON.parse(localStorage.getItem('ronin-scope') ?? '{}')); } catch { /* sin storage */ }
function saveScope() {
  try { localStorage.setItem('ronin-scope', JSON.stringify({ scope: S.scope, project: S.project })); } catch { /* sin storage */ }
}
const DETAIL_EVERY_MS = 30_000;
const WAITING_EVERY_MS = 10_000;

class Unauthorized extends Error {}

// Why the session ended, in the server's words when it says more than that
// there's none (a GitHub token revoked).
async function sessionEnded(response) {
  const why = (await response.json().catch(() => null))?.error;
  return why && why !== 'sin sesión' ? why : 'Tu sesión del tablero venció. Volvé a entrar.';
}

async function api(path, init) {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401) throw new Unauthorized(await sessionEnded(response));
  $('#relogin')?.remove();
  if (!response.ok) {
    // The API's own explanation when it has one (an action it refused).
    const body = await response.json().catch(() => null);
    // The rest of it too, for whoever needs more than the words (a deploy's new plan, #158).
    throw Object.assign(new Error(body?.error ?? `${path}: ${response.status}`), { body });
  }
  return response.status === 204 ? null : response.json();
}

// The session ended. With something written on screen (a dialog open, a
// comment half done) the page stays: a notice on top logs in again in
// another tab, and what was written is still here to send again. Returns
// whether the page went to the login (otherwise the caller shows its error).
function showLogin(error) {
  const writing = document.querySelector('body > div > .scrim, body > .scrim') || [...document.querySelectorAll('#shell textarea')].some((area) => area.value.trim());
  if (error && writing) {
    const note = $('#relogin') ?? Object.assign(document.body.appendChild(document.createElement('div')), { id: 'relogin', className: 'relogin', role: 'alert' });
    note.innerHTML = `<span>${esc(error.message)} Lo que escribiste sigue acá: entrá en otra pestaña y volvé a enviarlo.</span><a class="btn-s primary" href="/api/auth/login" target="_blank" rel="noopener">Entrar con GitHub</a>`;
    return false;
  }
  $('#login-why').hidden = !error || !S.snap;
  $('#login-why').textContent = error?.message ?? '';
  $('#shell').hidden = true;
  $('#login').hidden = false;
  return true;
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
// A cycle ends at midnight: its last day is the one before.
const endDay = (iso) => dayMonth(new Date(Date.parse(iso) - 1).toISOString());
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
  return item.lastRun ? runKind(item.lastRun) : '';
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
  if (S.page === 'ajustes') {
    $('#quick').innerHTML = ajNavHTML();
    wireAjNav();
    return;
  }
  const running = S.snap.items.filter((item) => item.status === 'running').length;
  const queued = S.snap.runner.queue.length;
  $('#quick').innerHTML = `
    <button data-home aria-pressed="${!S.sel && !S.page}"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Hoy</button>
    <button data-filter="running" aria-pressed="${S.filter === 'running'}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>Corriendo ahora<span class="c">${running}</span></button>
    <button data-filter="queue" aria-pressed="${S.filter === 'queue'}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>En cola<span class="c">${queued}</span></button>
    ${S.snap.portalAdmin || S.snap.pedidosTotal ? `<button data-portal aria-pressed="${['pedidos', 'pedido'].includes(S.page) && !S.sel}"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/></svg>Pedidos del portal<span class="c">${S.snap.pedidos?.length || ''}</span></button>` : ''}
    ${S.snap.repos.length ? `<button data-reuniones aria-pressed="${['reuniones', 'reunion'].includes(S.page) && !S.sel}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/></svg>Reuniones<span class="c">${S.snap.reunionesPorRevisar || ''}</span></button>` : ''}
    ${S.snap.despliegues ? `<button data-dep-page aria-pressed="${S.page === 'despliegues' && !S.sel}"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"/></svg>Despliegues<span class="c">${depGoing() ? 'en curso' : ''}</span></button>` : ''}
    ${xplRows().length ? `<button data-xpl-page aria-pressed="${['exploraciones', 'exploracion'].includes(S.page)}"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M14 8l-2 4-4 2 2-4z"/></svg>Exploraciones<span class="c">${xplToDecide() || ''}</span></button>` : ''}
    ${S.snap.access?.admin ? `<button data-mt-page aria-pressed="${S.page === 'metricas' && !S.sel}"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/></svg>Métricas</button>` : ''}`;
  $('#quick').querySelector('[data-home]').onclick = goHome;
  $('#quick').querySelector('[data-portal]')?.addEventListener('click', () => openPedidos());
  $('#quick').querySelector('[data-reuniones]')?.addEventListener('click', () => openReuniones());
  $('#quick').querySelector('[data-xpl-page]')?.addEventListener('click', () => openExploraciones());
  $('#quick').querySelector('[data-mt-page]')?.addEventListener('click', () => openMetricas());
  $('#quick').querySelector('[data-dep-page]')?.addEventListener('click', () => openDespliegues());
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

// HTML: an issue with an open PR shows it with GitHub's PR icon (open or
// draft) right after its own number.
function itemSub(item) {
  const parts = [esc(itemRef(item))];
  if (item.kind === 'issue' && item.pr) parts.push(`<span class="ipr">${ghIcon('pr', item.pr.isDraft ? 'draft' : 'open')}#${esc(item.pr.number)}${item.pr.author && item.pr.author !== 'ronin-agent' ? ` de ${esc(item.pr.author)}` : ''}</span>`);
  if (item.slices?.length) parts.push(esc(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} ${item.slices.length === 1 ? 'slice' : 'slices'}`));
  else if (item.kind === 'pr' && item.pr?.author && item.pr.author !== 'ronin-agent') parts.push(esc(`de ${item.pr.author}`));
  else if (item.kind !== 'other' && !item.pr && item.lastRun) parts.push(esc(runKind(item.lastRun)));
  return parts.filter(Boolean).join(', ');
}

const EXPLORE_ICON = '<svg class="pin-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m15 9-2 4-4 2 2-4z"/></svg>';

// `hit`: the PR number the search found the issue by, whose slice shows highlighted.
// An item's preview, on its sidebar row: ready to open, or still on its way
// (its data being prepared, or moving to a new commit).
function previewTag(preview) {
  if (!preview) return '';
  const ready = !preview.preparing && !preview.updating;
  const title = ready ? `Preview de #${preview.prNumber} lista` : preview.preparing ? `Preview de #${preview.prNumber}: preparando los datos` : `Preview de #${preview.prNumber}: actualizándose`;
  return `<span class="pvtag ${ready ? 'ok' : 'prep'}" title="${esc(title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>${ready ? 'preview' : 'preview…'}</span>`;
}

function itemRow(item, hit) {
  const last = itemLast(item);
  const showSlices = item.slices?.length && (S.sel === item.id || item.status === 'running' || item.status === 'blocked' || hit);
  const kids = showSlices ? `<div class="kids">${item.slices.map((slice) => `<button class="kid ${hit && slice.prNumber === hit ? 'hit' : ''}" data-id="${esc(item.id)}">${sliceMark(slice)}<span class="t">${slice.index + 1}. ${esc(slice.title)}</span><span class="age">${slice.prNumber ? `#${slice.prNumber}` : ''}</span></button>`).join('')}</div>` : '';
  return `<button class="item ${item.pinned ? 'pinned' : ''}" data-id="${esc(item.id)}" aria-current="${S.sel === item.id}" ${item.pinned ? 'title="PR de exploración: sus fichas se revisan acá"' : ''}>
    ${item.pinned ? EXPLORE_ICON : dot(item.status)}<span class="t">${esc(item.title)}</span><span class="age" ${item.status === 'running' && item.lastRun ? `data-since="${esc(item.lastRun.startedAt)}"` : ''}>${esc(itemAge(item))}</span>
    <span class="sub">${previewTag(item.preview)}${ghIcon(item.kind, item.github)}${itemSub(item)}${item.linear ? `, <span class="red">${esc(item.linear.id)}</span>` : ''}${item.linear?.project && !S.project ? `, <span class="ptag"><i style="background:${projectColor(item.linear.project.id)}"></i>${esc(item.linear.project.name)}</span>` : ''}</span>
    ${last ? `<span class="last">${esc(last)}</span>` : ''}</button>${kids}`;
}

function pedRow(p) {
  const tone = p.running ? 'live' : p.waitsOn === 'person' || p.waitsOn === 'team' ? 'warn' : p.waitsOn === 'ronin' ? 'run' : 'idle';
  return `<button class="item" data-ped="${p.number}" aria-current="${S.page === 'pedido' && S.ped.n === p.number}">${dotClass(tone)}<span class="t"><span class="pd-pn">P-${p.number}</span> ${esc(p.title)}</span><span class="age">${esc(short(Date.now() - Date.parse(p.lastAt)))}</span>
    <span class="sub">${esc(waitsLabel(p))}</span></button>`;
}

// An app a repo explores (#155): exploring it now, findings to decide on, or nothing pending.
function xplRow(r) {
  const c = xplCounts(r);
  const tone = r.running ? 'live' : c?.decidir ? 'warn' : c?.esperando ? 'run' : 'idle';
  const sub = r.running ? `explorando${r.running.fn ? ` ${r.running.fn}` : ''}` : !r.pr ? 'sin PR de exploración' : c ? (c.decidir ? `${c.decidir} ${c.decidir === 1 ? 'ficha' : 'fichas'} por decidir` : c.esperando ? 'esperando a ronin' : 'nada por decidir') : `PR #${r.pr.number}`;
  return `<button class="item" data-xpl="${esc(xplKey(r))}" aria-current="${S.page === 'exploracion' && S.xpl.repo === r.repo && S.xpl.app === r.app}">${dotClass(tone)}<span class="t">${esc(r.app)}</span><span class="age">${r.pr ? `#${r.pr.number}` : ''}</span>
    <span class="sub">${esc(repoShort(r.repo))}, ${esc(sub)}</span></button>`;
}

function renderTree() {
  const tree = $('#tree');
  if (S.page === 'ajustes') {
    tree.innerHTML = '';
    return;
  }
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
    if (item.kind !== 'issue') return false;
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
  // The apps ronin explores (#155), whose exploration PR is no longer pinned in its repo: searched by the app or the PR's number.
  const xpls = xplRows().filter((r) => (S.filter !== 'running' || r.running) && (!q || r.app.toLowerCase().includes(q) || (num && r.pr?.number === Number(num))));
  if (xpls.length) html += `<div class="grp"><span>Exploraciones</span><span class="n">${xpls.length}</span></div>` + xpls.map(xplRow).join('');
  for (const repo of S.snap.repos) {
    const items = S.snap.items.filter((item) => item.repo === repo && item.status !== 'blocked' && shown(item));
    html += `<div class="grp"><span class="sq" style="background:${repoColor(repo)}"></span><b>${esc(repoShort(repo))}</b><span class="n">${items.length}</span>${canDo(repo, 'acciones') ? `<button class="grp-add" data-new="${esc(repo)}" title="Nuevo issue en ${esc(repoShort(repo))}" aria-label="Nuevo issue en ${esc(repoShort(repo))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` : ''}</div>`;
    html += items.length ? items.map(row).join('') : `<div class="grp-empty">${q || S.filter ? 'Nada coincide.' : S.scope === 'cycle' || S.project ? `Ningún issue abierto ${S.scope === 'cycle' ? 'en este ciclo' : ''}${S.project ? ' para este proyecto' : ''}.` : 'Nada en curso ni corridas en los últimos 3 días.'}</div>`;
    // A number nothing listed has: open it anyway (a closed issue, a PR without an issue).
    if (num && !found && safeRepo(repo)) {
      html += `<button class="item open-n" data-id="${esc(`${repo}#${num}`)}"><span class="dot pending" aria-hidden="true"></span><span class="t">Abrir #${esc(num)}</span><span class="sub">${esc(repoShort(repo))}, aunque esté cerrado o no tenga issue</span></button>`;
    }
  }
  tree.innerHTML = html;
  for (const button of tree.querySelectorAll('[data-id]')) button.onclick = () => select(button.dataset.id);
  for (const button of tree.querySelectorAll('[data-ped]')) button.onclick = () => openPedido(Number(button.dataset.ped));
  for (const button of tree.querySelectorAll('[data-xpl]')) button.onclick = () => openExploracion(...splitXplKey(button.dataset.xpl));
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
const runName = (item, run, title = runTitle) => title(run) + (run.issueNumber == null && run.prNumber != null && run.prNumber !== item.number ? ` en #${run.prNumber}` : '');
const itemRuns = (item) => S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
// The item's runs as they're listed (newest first, as itemRuns): one entry
// per run, but a group's steps together as one, its newest first. `idx`:
// their places in itemRuns.
function runEntries(runs) {
  const out = [];
  runs.forEach((run, i) => {
    const last = out.at(-1);
    if (groupName(run) && last?.group === run.group) last.idx.push(i);
    else out.push({ group: groupName(run) ? run.group : undefined, idx: [i] });
  });
  return out;
}
// A group as one run: running while a step runs, else how its last step
// ended (or the first one that failed); from its first step to its last.
function entryRun(runs, entry) {
  const steps = entry.idx.map((i) => runs[i]);
  if (steps.length === 1) return steps[0];
  const failed = steps.find((run) => ['error', 'timeout', 'cut', 'usage_limit'].includes(run.state));
  const state = steps.some((run) => run.state === 'running') ? 'running' : failed?.state ?? steps[0].state;
  const sum = (key) => (steps.some((run) => run[key] !== undefined) ? steps.reduce((total, run) => total + (run[key] ?? 0), 0) : undefined);
  return { ...steps[0], state, startedAt: steps.at(-1).startedAt, durationMs: sum('durationMs'), costUsd: sum('costUsd'), ...(failed?.error ? { error: failed.error } : {}) };
}
const entryName = (item, runs, entry) => runName(item, runs[entry.idx[0]], entry.idx.length > 1 ? runKind : runTitle);
// The item's page by default; the transcript for what has no page (a changelog entry).
const viewOf = (item) => S.view[item.id] ?? (item.kind === 'other' ? 'tx' : 'ficha');

function renderCenter() {
  for (const onChange of shellListeners) onChange();
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
    if (S.page === 'pedido') showPage('request', backBar(`Pedido P-${S.ped.n}`), S.ped);
    else showPage('requests', backBar('Portal de pedidos'));
    // Its issue and PR follow the snapshot (their checks, their review).
    drawPedDoc();
    return;
  }
  if (!item && (S.page === 'reuniones' || S.page === 'reunion')) {
    $('#shell').classList.toggle('wide', S.page === 'reunion');
    if (S.page === 'reunion') showPage('meeting', backBar(`Reunión R-${S.reu.n}`), { n: S.reu.n, run: S.reu.run });
    else showPage('meetings', backBar('Reuniones'));
    return;
  }
  if (!item && S.page === 'despliegues') {
    showPage('deploys', backBar('Despliegues'));
    return;
  }
  if (!item && S.page === 'metricas') {
    // Its tables and charts take the room of the context column.
    $('#shell').classList.add('wide');
    showPage(S.mt.tab === 'suscripcion' ? 'subscription' : 'metrics', backBar('Métricas'));
    return;
  }
  if (!item && (S.page === 'exploraciones' || S.page === 'exploracion')) {
    setCenter(backBar(S.page === 'exploracion' ? S.xpl.app : 'Exploraciones') + (S.page === 'exploracion' ? xplAppHTML() : xplListHTML()));
    return;
  }
  if (!item && S.page === 'ajustes') {
    $('#shell').classList.add('wide');
    // Mounted again on each visit: the page reads what to show, and reads it again.
    showPage('settings', backBar('Ajustes'), {}, `settings-${ajVisits}`);
    return;
  }
  if (!item) {
    showPage('today', tabs + backBar('Hoy'));
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
  const typing = ['fcomment', 'fcbox', 'rsum', 'dtext'].includes(document.activeElement?.id) ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const menuAt = document.activeElement?.closest?.('.menu [data-action]')?.dataset.action;
  if (!setCenter(tabs + backBar(item.title) + headHTML(item) + activityHTML(item) + docHTML(item) + `<div class="ctx-inline">${ctxHTML(item)}</div>`)) return;
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
  if (menuAt) [...document.querySelectorAll('.menu [data-action]')].find((b) => b.dataset.action === menuAt)?.focus();
}

// Only touches the page when something changed, so a snapshot that changes
// nothing doesn't reset a selection or a scroll. False when it was the same.
// A page in React (src/apps/dashboard/, #235 stage 7): mounted once where
// it goes, under its head, and unmounted when the center shows anything
// else (setCenter). It reads, polls and redraws on its own.
let reactPage = null;
// The pages that draw from the snapshot (Hoy), told each time the shell draws.
const shellListeners = new Set();
const PAGE_HOST = {
  toast,
  openPedido: (n) => openPedido(n),
  openPedidos: () => openPedidos(),
  unauthorized: (message) => showLogin(new Unauthorized(message)),
  repoColor,
  openItem: (key) => select(key),
  openSettings: (section, login, f, cuenta) => openAjustes(section, login, f, cuenta),
  openMetrics: (tab) => openMetricas(tab),
  settingsView: () => ({ section: S.aj.sec, login: S.aj.login, repo: S.aj.repo, account: S.aj.cuenta, filter: S.aj.f }),
  session: () => ({ me: S.snap.me, portalAdmin: Boolean(S.snap.portalAdmin) }),
  openPedidos: () => openPedidos(),
  setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('ronin-theme', theme); } catch { /* sin storage */ }
    renderStatus();
  },
  repos: () => S.snap.repos,
  typeName,
  requestsTotal: () => S.snap.pedidosTotal ?? 0,
  portalAdmin: () => Boolean(S.snap.portalAdmin),
  openPortalAccounts: () => openAjustes('usuarios', null, 'portal'),
  requestDoc(element, doc, onShow) {
    pedDoc = { element, doc, onShow };
    drawPedDoc();
    return () => {
      if (pedDoc?.element === element) pedDoc = null;
    };
  },
  openMeetings: () => openReuniones(),
  openMeeting: (n) => openReunion(n),
  can: canDo,
  me: () => S.snap?.me ?? '',
  planning: (repo) => linearRepos().find((l) => l.repo === repo)?.planning ?? null,
  markdown: md,
  hasItem: (key) => Boolean(itemById(key)),
  refresh: () => refresh(),
  snapshot: () => S.snap,
  subscribe(onChange) {
    shellListeners.add(onChange);
    return () => shellListeners.delete(onChange);
  },
  project: () => S.project,
  setProject(id) {
    S.project = id;
    saveScope();
    renderAll();
  },
  projectColor,
  openRun(key, runId) {
    S.pendingRun = runId;
    select(key);
  },
  // What the sidebar shows of a page: whether a deploy is going, the
  // projects of the cycles (their colors).
  read(name, data) {
    if (name === 'today') {
      S.today = data;
      renderTree();
      for (const onChange of shellListeners) onChange();
    }
    if (name !== 'deploys') return;
    S.dep.list = data;
    renderQuick();
  },
};

// `props`: what the page is about (a request's number), mounted again when it
// changes; `key`, what else makes it a new page to mount (Ajustes: each visit).
function showPage(name, head, props = {}, key = '') {
  const center = $('#center');
  const id = JSON.stringify([name, head, props, key]);
  if (reactPage?.key === id && center.contains(reactPage.element)) return;
  if (!setCenter(`${head}<div class="react-page" data-page="${esc(name)}"></div>`)) reactPage?.unmount();
  const element = center.querySelector('.react-page');
  reactPage = { name, key: id, element, unmount: window.roninPages.mount(name, element, PAGE_HOST, { ...props }) };
}

function setCenter(html) {
  const center = $('#center');
  if (center._html === html) return false;
  reactPage?.unmount();
  reactPage = null;
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
  const pill = (run, i, label, pressed) => `<button class="pill" data-run="${i}" aria-pressed="${pressed}">${dot(run.state)}${esc(label)}<span class="m">${run.state === 'running' ? 'en curso' : `${hhmm(run.startedAt)}${run.durationMs !== undefined ? `, ${duration(run.durationMs)}` : ''}`}</span></button>`;
  const entries = runEntries(runs);
  const open = entries.find((entry) => entry.idx.includes(index));
  // A group's steps, oldest first, under its pill.
  const steps = open.idx.length > 1
    ? `<div class="runs steps"><span class="lbl">Pasos</span>${[...open.idx].reverse().map((i) => pill(runs[i], i, typeName(runs[i].taskType), i === index)).join('')}</div>`
    : '';
  const pills = `<div class="runs">${back}<span class="lbl">Corridas</span>${entries.map((entry) => pill(entryRun(runs, entry), entry.idx[0], entryName(item, runs, entry), entry === open)).join('')}</div>${steps}`;

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
        : `<span>${esc(STATE[loaded.summary.state]?.[2] ?? loaded.summary.state)}</span>`}<span>${esc(runTitle(loaded.summary))}</span><span class="r">${esc([loaded.summary.model, loaded.summary.worktree].filter(Boolean).join('  '))}</span></div>`;
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
  const xr = xplOfItem(item.id);
  if (xr) return xplHeadHTML(item, xr);
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
    <div class="row"><h1>${esc(item.title)}${item.number !== undefined ? ` <span class="n">${esc(itemRef(item))}</span>` : ''}</h1>${d?.exploration ? '<button class="gh" data-xpr="general">Comentario general</button>' : ''}${decidable(item, d) ? `<div class="hbtns">${decideHTML(item, d)}${actionsHTML(d)}</div>` : reviewable(item, d) ? reviewButton(item, 'head', pendingOf(item.id).length ? `<button class="act-btn" data-frev="head" aria-haspopup="dialog" aria-expanded="${revOpen(item, 'head')}">Terminar revisión <span class="rn">${pendingOf(item.id).length}</span> ▾</button>` : `<button class="gh" data-frev="head" aria-haspopup="dialog" aria-expanded="${revOpen(item, 'head')}">${esc(reviewLabel(item, d))} ▾</button>`) : ''}${decidable(item, d) ? '' : actionsHTML(d)}${d?.exploration ? '<button class="act-btn" data-xpr="approve" title="Termina la revisión: aprueba las fichas que quedan y mergea el PR">Finalizar…</button>' : ''}</div>
    <div class="state">${ghPill(item, d)}${d?.pedido ? `<button class="chip plain" data-goped="${d.pedido.number}" title="${esc(d.pedido.title)}">del pedido P-${d.pedido.number}</button>` : ''}${linearChips(item)}${chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('')}${decidable(item, d) && pendingOf(item.id).length ? `<span class="chip run">✎ ${pendingOf(item.id).length} en Archivos</span>` : ''}${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>${decidedHTML(item)}</div>`;
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
  const item = S.sel && itemById(S.sel);
  if (!d?.actions?.length || (item && !canDo(item.repo, 'acciones'))) return '';
  const menu = S.menu ? `<div class="menu" role="menu">${d.actions.map((a, i) => `<button role="menuitem" data-action="${esc(a.id)}" class="${a.primary ? 'primary' : ''}"><b>${i < 9 ? `<kbd>${i + 1}</kbd> ` : ''}${esc(a.label)}</b><span class="k">${esc(a.command)}</span><small>${esc(a.help)}</small></button>`).join('')}</div>` : '';
  return `<div class="actions"><button class="act-btn" id="act" aria-haspopup="menu" aria-expanded="${S.menu}" title="Acciones (M)">Acciones <kbd>M</kbd> ▾</button>${menu}</div>`;
}

function openAction(id) {
  const action = S.detail[S.sel]?.data?.actions?.find((a) => a.id === id);
  if (!action) return;
  S.menu = false;
  S.dialog = { item: S.sel, action, text: '', app: action.app ?? action.apps?.[0] ?? '', sending: false, error: null };
  renderCenter();
  renderDialog();
}

// The Actions menu from the keyboard: M opens it on its first action, and
// in it a digit picks one, j/k or the arrows move, Enter asks for it.
function toggleActions() {
  S.menu = !S.menu;
  S.fmenu = false;
  renderCenter();
  if (S.menu) document.querySelector('.menu [data-action]')?.focus();
  else $('#act')?.focus();
}

// True when the key was the menu's.
function actionsKey(event) {
  if (!S.menu || event.ctrlKey || event.metaKey || event.altKey) return false;
  const all = [...document.querySelectorAll('.menu [data-action]')];
  if (!all.length) return false;
  if (/^[1-9]$/.test(event.key) && all[Number(event.key) - 1]) {
    event.preventDefault();
    openAction(all[Number(event.key) - 1].dataset.action);
    return true;
  }
  const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key];
  if (step) {
    event.preventDefault();
    const at = all.indexOf(document.activeElement);
    all[at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length].focus();
    return true;
  }
  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggleActions();
    return true;
  }
  return false;
}

function renderDialog() {
  let layer = $('#layer');
  if (!S.dialog) {
    layer?.remove();
    return;
  }
  if (!layer) layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'layer' });
  const { action, text, app, sending, error } = S.dialog;
  // `…` stands for the text: filled as it's typed, left out when the text is optional and empty.
  // `{app}`, for the app picked. On one line, as the server writes it.
  const typed = action.apps && action.id !== 'preview' ? text.trim().replace(/\s+/g, ' ') : text.trim();
  const preview = (!action.text ? action.preview : typed ? action.preview.replace('…', typed) : action.text.required ? action.preview : action.preview.replace(/(\n\n| )?…$/, '')).replace('{app}', app);
  const me = esc(S.snap?.me ?? '');
  const bot = esc(S.detail[S.dialog.item]?.data?.ronin ?? 'ronin');
  // Assigning and closing comment only when there's something to say.
  const said = action.id === 'assign' ? (typed ? `Comentás en #${esc(action.target)} y se lo asignás a @${bot}, como ${me}` : `Se lo asignás a @${bot} como ${me}, sin comentario`)
    : action.id === 'close-issue' ? (typed ? `Comentás en #${esc(action.target)} y lo cerrás como no planeado, como ${me}` : `Lo cerrás como no planeado, como ${me}, sin comentario`)
    : `Comentás en #${esc(action.target)} como ${me}`;
  const fresh = !layer.firstChild;
  if (fresh) {
    layer.innerHTML = `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">${esc(action.label)}</h2>
      <p class="help">${esc(action.help)}</p>
      ${action.apps ? `<label class="field"><span>App</span><select id="dlg-app">${action.apps.map((a) => `<option value="${esc(a)}"${a === app ? ' selected' : ''}>${esc(a)}${a === action.app && action.appNote ? ` · ${esc(action.appNote)}` : ''}</option>`).join('')}</select></label>` : ''}
      ${action.text ? `<label class="field"><span>${esc(action.text.label)}</span><textarea id="dlg-text" rows="4" maxlength="4000" placeholder="${esc(action.text.placeholder)}"></textarea></label>` : ''}
      <div class="prev"><div class="lbl" id="dlg-said"></div><div class="md" id="dlg-prev"></div></div>
      <p class="bad" id="dlg-err" hidden></p>
      <div class="foot-d"><span class="kbd-hint"><kbd>Ctrl</kbd> <kbd>Enter</kbd> para ${action.id === 'assign' ? 'asignar' : action.id === 'close-issue' ? 'cerrar' : 'comentar'}</span><button class="btn-s" id="dlg-no">Cancelar</button><button class="btn-s primary" id="dlg-yes"></button></div></div></div>`;
    const area = $('#dlg-text');
    if (area) area.oninput = () => { S.dialog.text = area.value; renderDialog(); };
    const pick = $('#dlg-app');
    if (pick) pick.onchange = () => { S.dialog.app = pick.value; renderDialog(); };
    $('#dlg-no').onclick = closeDialog;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeDialog(); };
    $('#dlg-yes').onclick = sendAction;
    // Anywhere in the dialog, as long as the button could be pressed.
    layer.querySelector('.dlg').onkeydown = (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('#dlg-yes').disabled) {
        event.preventDefault();
        sendAction();
      }
    };
    (area ?? $('#dlg-yes')).focus();
  }
  $('#dlg-said').innerHTML = said;
  $('#dlg-prev').innerHTML = md(preview, itemById(S.dialog.item)?.repo ?? '');
  $('#dlg-prev').hidden = !preview;
  const yes = $('#dlg-yes');
  yes.textContent = action.id === 'assign' ? (sending ? 'Asignando…' : 'Asignar a ronin') : action.id === 'close-issue' ? (sending ? 'Cerrando…' : 'Cerrar el issue') : sending ? 'Comentando…' : action.id === 'unblock' ? 'Comentar y destrabar' : 'Comentar';
  yes.classList.toggle('danger-solid', action.id === 'close-issue');
  yes.classList.toggle('primary', action.id !== 'close-issue');
  yes.disabled = sending || Boolean(action.text?.required && !text.trim());
  $('#dlg-err').hidden = !error;
  $('#dlg-err').textContent = error ?? '';
}

function closeDialog() {
  if (S.dialog?.sending) return;
  S.dialog = null;
  renderDialog();
}

// How long an action waits for the server's answer. The comment is usually
// out within a few seconds; past this, the answer was lost on the way (a
// phone whose connection to the tailnet dropped), and waiting longer would
// leave the dialog on "Comentando…" for good.
const ACTION_TIMEOUT_MS = 30_000;

async function sendAction() {
  const dialog = S.dialog;
  if (!dialog || dialog.sending) return;
  dialog.sending = true;
  dialog.error = null;
  renderDialog();
  try {
    const { url } = await api(`/api/items/${encodeURIComponent(dialog.item)}/actions`, { method: 'POST', body: JSON.stringify({ action: dialog.action.id, ...(dialog.text.trim() ? { text: dialog.text.trim() } : {}), ...(dialog.action.apps ? { app: dialog.app } : {}) }), signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
    S.dialog = null;
    renderDialog();
    toast(dialog.action.id === 'assign' ? `Listo: se lo asignaste a ronin. Lo toma en el próximo tick.` : dialog.action.id === 'close-issue' ? `Listo: cerraste #${dialog.action.target}.` : `Listo: comentaste en #${dialog.action.target}.`, url);
    const item = itemById(dialog.item);
    // Its comment is where the answer will come: the tab of what it was on (the issue or its PR).
    const d = S.detail[dialog.item]?.data;
    if (item && d) S.doc[dialog.item] = d.pr?.number === dialog.action.target ? 'pr' : 'issue';
    if (S.detail[dialog.item]) S.detail[dialog.item].at = 0;
    await loadDetail(dialog.item);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    dialog.sending = false;
    // No answer, or the connection dropped: the comment may well be out
    // already. The item is read again so its conversation says.
    const lost = error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError;
    dialog.error = lost
      ? 'No llegó la respuesta del servidor. El comentario puede haberse publicado igual: mira la conversación del ítem antes de volver a intentar.'
      : `No se pudo: ${error.message}`;
    renderDialog();
    if (lost) {
      if (S.detail[dialog.item]) S.detail[dialog.item].at = 0;
      loadDetail(dialog.item).catch(() => {});
    }
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
  const entries = runEntries(runs);
  // The latest run (a group of steps as one) is the line itself, or the card below it; the older ones, pills that open their transcript.
  const latest = entryRun(runs, entries[0]);
  const older = entries.slice(1).map((entry) => {
    const run = entryRun(runs, entry);
    return `<button class="pill" data-runview="${entry.idx[0]}">${dot(run.state)}${esc(entryName(item, runs, entry))}<span class="m">${esc(short(Date.now() - Date.parse(run.endedAt ?? run.startedAt)))}</span></button>`;
  }).join('');
  let summary = '';
  if (latest.state !== 'running') {
    const [, , label] = STATE[latest.state] ?? STATE.error;
    const facts = [label, `hace ${short(Date.now() - Date.parse(latest.endedAt ?? latest.startedAt))}`, latest.durationMs !== undefined ? duration(latest.durationMs) : null, latest.costUsd !== undefined ? money(latest.costUsd) : null].filter(Boolean).join(' · ');
    summary = `<span class="latest">${dot(latest.state)}<b>${esc(entryName(item, runs, entries[0]))}</b><span class="m">${esc(facts)}</span></span>`;
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
  // An issue with a PR opens on the PR, what was done (its "Qué se pidió" says what was asked).
  if (item.kind === 'issue') return d?.pr ? [['pr', `PR #${d.pr.number}`], ['issue', 'Issue'], ['files', 'Archivos']] : [['issue', 'Issue']];
  // An exploration PR opens on its findings, to review them (#93); as its app's page, with the app's runs and inventory (#155).
  const xpl = d?.exploration && xplOfItem(item.id) ? [['corridas', 'Corridas'], ['inventario', 'Inventario']] : [];
  return [...(d?.exploration ? [['fichas', 'Fichas']] : []), ...xpl, ['pr', 'Descripción'], ...(d?.issue ? [['issue', `Issue #${d.issue.number}`]] : []), ['files', 'Archivos']];
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
  // Each tab's own conversation: the issue's comments, the PR's comments and reviews.
  const convOf = (k) => (k === 'issue' ? d.issue : k === 'pr' ? d.pr : undefined);
  const count = (k) => (convOf(k) ? conversation(convOf(k)).length : 0);
  const fichas = S.expl[item.id]?.data?.fichas;
  const files = S.files[item.id];
  const counter = (k) => ((k === 'issue' || k === 'pr') && count(k) ? `<span class="c">${count(k)}</span>` : k === 'fichas' && fichas ? `<span class="c">${fichas.length}</span>` : k === 'files' && files?.data ? `<span class="c">${files.data.files.length}</span>` : '');
  const bar = `<div class="doctabs" role="tablist">${tabs.map(([k, label]) => `<button class="doctab" role="tab" data-doc="${k}" aria-selected="${k === cur}">${esc(label)}${counter(k)}</button>`).join('')}
    <span class="keys"><kbd>1</kbd>–<kbd>${tabs.length}</kbd> pestaña · ${cur === 'fichas' ? '<kbd>j</kbd> <kbd>k</kbd> otra ficha' : cur === 'files' ? `<kbd>j</kbd> <kbd>k</kbd> otro archivo · <kbd>v</kbd> visto${decidable(item, d) ? '' : ' · <kbd>r</kbd> revisión'}` : '<kbd>j</kbd> <kbd>k</kbd> sección o comentario'} <button class="kh" data-keys title="Atajos (?)" aria-label="Atajos">?</button></span><span class="src">${d.error ? `<span class="bad">GitHub no respondió: ${esc(d.error)}</span>, ` : ''}${d.fetchedAt ? `leído hace ${esc(short(Date.now() - Date.parse(d.fetchedAt)))}` : ''}</span></div>`;
  if (cur === 'fichas') return bar + fichasHTML(item);
  if (cur === 'corridas' || cur === 'inventario') {
    const xr = xplOfItem(item.id);
    return bar + `<div class="doc" id="doc" data-key="${esc(`${item.id}:${cur}`)}"><div class="xpl-doc">${cur === 'corridas' ? xplCorridasHTML(xr) : xplInventarioHTML(xr)}</div></div>`;
  }
  if (cur === 'files') {
    // Read when the tab is first shown, and again once old (refresh).
    if (!files) queueMicrotask(() => loadFiles(item.id));
    return bar + filesHTML(item);
  }
  const doc = cur === 'issue' ? d.issue : d.pr;
  const other = (cur === 'issue') !== (item.kind === 'issue');
  const entries = conversation(doc);
  const conv = `<section class="conv"><h3>Comentarios ${cur === 'pr' ? 'del PR' : 'del issue'}${entries.length ? ` <span class="c">${entries.length}</span>` : ''}</h3>${entries.length
    ? `<div class="comments">${entries.map((e) => entryHTML(e, d, doc, item.repo)).join('')}</div>`
    : '<p class="m">Nadie comentó todavía.</p>'}</section>`;
  const body = `<div class="page">${other ? `<a class="other" href="${esc(doc.url)}" target="_blank" rel="noopener">${esc(doc.title)} <span class="m">${cur === 'pr' ? 'PR' : 'Issue'} #${esc(doc.number)} ↗</span></a>` : ''}
      <div class="meta">${avatar(doc.author)}<b>${esc(doc.author)}</b><span>${esc(when(doc.createdAt))}</span></div>${cur === 'pr' ? prStateHTML(item, doc) : ''}
      ${cur === 'pr' && sameLogin(doc.author, d.ronin) ? prBodyHTML(doc.body, item.repo) : `<div class="md">${doc.body.trim() ? md(doc.body, item.repo) : '<p class="m">Sin descripción.</p>'}</div>`}</div>${conv}`;
  return bar + `<div class="doc" id="doc" data-key="${esc(`${item.id}:${cur}`)}">${body}</div>`;
}

const sameLogin = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

// The sections every PR ronin opens has (#195, PR_BODY_SECTIONS in
// platform/agents/prompts.ts), each under its heading; what it decided on its own
// stands out, it's what most needs a look. A body without them (an older
// PR) shows as it is.
const PR_SECTIONS = ['Qué se pidió', 'Qué cambió', 'Cómo se verificó', 'Decisiones propias', 'Fuera de alcance'];
function prBodyHTML(body, repo) {
  const parts = body.split(/^##[ \t]+(.+?)[ \t]*$/m);
  if (!parts.some((part, i) => i % 2 === 1 && PR_SECTIONS.includes(part))) return `<div class="md">${body.trim() ? md(body, repo) : '<p class="m">Sin descripción.</p>'}</div>`;
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) sections.push(`<section class="psec${parts[i] === 'Decisiones propias' ? ' decis' : ''}"><h3>${esc(parts[i])}</h3><div class="md">${md(parts[i + 1].trim(), repo)}</div></section>`);
  return `${parts[0].trim() ? `<div class="md pre">${md(parts[0].trim(), repo)}</div>` : ''}${sections.join('')}`;
}

// Where a PR stands, on its tab (an issue's PR included): open or how it
// ended, its review and who approved it or asked for changes, auto-merge,
// checks and conflicts — what was only on GitHub.
function prStateHTML(item, doc) {
  if (doc.state === 'MERGED') return '<div class="prstate"><span class="chip ok">mergeado</span></div>';
  if (doc.state === 'CLOSED') return '<div class="prstate"><span class="chip idle">cerrado sin mergear</span></div>';
  // The sidebar's read of the PR: its checks, and a review just sent (showSentReviews).
  const live = item.pr?.number === doc.number ? item.pr : null;
  const decision = live?.reviewDecision || doc.reviewDecision;
  const by = (state) => (doc.decisions ?? []).filter((x) => x.state === state).map((x) => x.author);
  const approved = by('APPROVED');
  const changes = by('CHANGES_REQUESTED');
  const chips = [doc.isDraft ? ['idle', 'draft'] : ['run', 'abierto']];
  if (decision === 'CHANGES_REQUESTED') chips.push(['warn', changes.length ? `cambios pedidos por ${changes.join(', ')}` : 'cambios pedidos']);
  else if (decision === 'APPROVED') chips.push(['ok', approved.length ? `aprobado por ${approved.join(', ')}` : 'aprobado']);
  else if (approved.length) chips.push(['warn', `aprobado por ${approved.join(', ')}${decision === 'REVIEW_REQUIRED' ? ', faltan aprobaciones' : ''}`]);
  else chips.push(['plain', decision === 'REVIEW_REQUIRED' ? 'falta la aprobación' : 'sin aprobar']);
  chips.push(doc.labels.includes('ronin:auto-merge') ? ['ok', 'auto-merge activo'] : ['plain', 'sin auto-merge']);
  const checks = checksChip(live?.checks);
  if (checks) chips.push(checks);
  if (doc.mergeable === 'CONFLICTING') chips.push(['crit', `conflictos con ${doc.baseRefName}`]);
  return `<div class="prstate">${chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('')}</div>`;
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
    <span class="m hint-c">Clic en un número de línea para comentarla</span>${decidable(item, S.detail[item.id]?.data) ? (pendingOf(item.id).length ? `<span class="m dcarry">${oneOr(pendingOf(item.id).length, 'Un comentario', `${pendingOf(item.id).length} comentarios`)} para ronin: los lleva <b>Ajustar</b> <kbd>P</kbd></span>` : '') : reviewOf(item.id) ? reviewButton(item, 'files', `<button class="btn-s primary frevb" data-frev="files" aria-haspopup="dialog" aria-expanded="${revOpen(item, 'files')}">Terminar revisión <span class="rn">${pendingOf(item.id).length}</span> ▾</button>`) : reviewable(item, S.detail[item.id]?.data) ? reviewButton(item, 'files', `<button class="btn-s frevb" data-frev="files" aria-haspopup="dialog" aria-expanded="${revOpen(item, 'files')}">Revisar ▾</button>`) : ''}${url ? `<a class="gh" href="${esc(url)}/files" target="_blank" rel="noopener">En GitHub ↗</a>` : ''}</div>`;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    else toast(mode === 'edit' ? 'Guardado en tu revisión.' : started ? `Empezaste una revisión: nadie la ve hasta que la mandes${decidable(itemById(c.item) ?? {}, S.detail[c.item]?.data) ? ' con Ajustar' : ''}.` : 'Sumado a tu revisión.');
    afterFilesWrite(c.item);
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
    toast(`No se pudo: ${error.message}`);
  } finally {
    S.fbusy.delete(nodeId);
    renderCenter();
  }
}

// ---------- deciding a PR ronin opened (#195)
// Its page asks what's decided, not how to review it: merge it, ask ronin
// for an adjustment, or close it. Always in the header, so on every tab,
// and a key away (A, P, X). A PR by anyone else keeps the review panel below.
const decidable = (item, d) => reviewable(item, d) && Boolean(d.ronin) && (d.pr.author ?? '').toLowerCase() === d.ronin.toLowerCase() && !d.pr.isDraft;
const DECIDE_QUICK = ['Agregá un test para este caso', 'Revertí una de las decisiones propias', 'Separá esto en otro PR'];
const oneOr = (n, one, many) => (n === 1 ? one : many);

function decideHTML(item, d) {
  const open = (kind) => S.decide?.item === item.id && S.decide.kind === kind;
  return `<div class="actions dwrap"><button class="gh dbtn danger" data-decide="close" aria-haspopup="dialog" aria-expanded="${open('close')}" title="Cerrar el PR (X)">Cerrar <kbd>X</kbd></button><button class="gh dbtn run" data-decide="adjust" aria-haspopup="dialog" aria-expanded="${open('adjust')}" title="Pedirle un ajuste a ronin (P)">Ajustar <kbd>P</kbd></button><button class="act-btn dbtn ok" data-decide="approve" aria-haspopup="dialog" aria-expanded="${open('approve')}" title="Aprobar y mergear (A)">Aprobar <kbd>A</kbd></button>${dropHTML(item, d)}</div>`;
}

// What was just decided here, for a few minutes: GitHub takes a moment to show it.
const DECIDED_SHOWN_MS = 10 * 60_000;
function decidedHTML(item) {
  const done = S.decided[item.id];
  if (!done || Date.now() - done.at > DECIDED_SHOWN_MS) return '';
  const what = done.kind === 'approve'
    ? `Aprobaste el PR${done.autoMerge ? ' y le pediste el auto-merge a ronin' : ''}.`
    : done.kind === 'adjust'
      ? `Le pediste un ajuste a ronin${done.count ? ` con ${oneOr(done.count, 'un comentario', `${done.count} comentarios`)} de Archivos` : ''}. Lo toma en el próximo tick.`
      : `Cerraste el PR${done.issue ? ' y su issue' : ''}.`;
  return `<div class="decided">${what}${done.url ? ` <a href="${esc(done.url)}" target="_blank" rel="noopener">Ver ↗</a>` : ''}</div>`;
}

function dropHTML(item, d) {
  const p = S.decide;
  if (!p || p.item !== item.id) return '';
  const n = pendingOf(item.id).length;
  const me = esc(S.snap?.me ?? '');
  const bot = esc(d.ronin);
  const err = p.error ? `<p class="bad">${esc(p.error)}</p>` : '';
  const busy = p.sending ? ' disabled' : '';
  if (p.kind === 'approve') {
    const checks = checksChip(item.pr?.checks);
    const autoMerge = !d.pr.labels?.includes('ronin:auto-merge') && d.pr.mergeable !== 'CONFLICTING';
    const when = d.pr.mergeable === 'CONFLICTING' ? `Tiene conflictos con ${esc(d.pr.baseRefName ?? 'la base')}: no se va a mergear hasta que se resuelvan.`
      : checks?.[0] === 'crit' ? '<span class="crit">Un check falla: no se va a mergear hasta que pase.</span> Quizá conviene <b>Ajustar</b>.'
        : checks?.[0] === 'run' ? 'ronin lo mergea apenas pasen los checks.' : 'ronin lo mergea en el próximo tick.';
    return `<div class="drop ok" role="dialog" aria-label="Aprobar y mergear"><div class="dt">Lo aprobás como <b>${me}</b>${autoMerge ? ` y comentás <code>@${bot} /auto-merge</code> a tu nombre` : ''}. ${when}
      ${n ? `<p class="warnbox">${oneOr(n, 'Tu comentario', `Tus ${n} comentarios`)} de Archivos ${n === 1 ? 'va' : 'van'} con la aprobación, pero ronin no ${n === 1 ? 'lo atiende' : 'los atiende'}: para eso, <b>Ajustar</b>.</p>` : ''}</div>${err}
      <footer><span class="m"><kbd>↵</kbd> confirma · <kbd>Esc</kbd></span><button class="btn-s" data-dcancel>Cancelar</button><button class="btn-s ok-solid" data-dsend${busy}>Aprobar y mergear</button></footer></div>`;
  }
  if (p.kind === 'close') {
    const issue = item.kind === 'issue' ? item.number : d.issue?.number;
    return `<div class="drop crit" role="dialog" aria-label="Cerrar el PR"><textarea id="dtext" rows="3" placeholder="Por qué lo cerrás (opcional). Queda como comentario en el PR.">${esc(p.text)}</textarea>
      ${d.pedido && issue !== undefined ? `<p class="help">Es el pedido P-${esc(d.pedido.number)} del portal: si cerrás también el issue, este motivo le llega a quien lo pidió, en el portal y por correo. Sin motivo, recibe el aviso de siempre.</p>` : ''}
      ${issue !== undefined ? `<label class="dchk"><input type="checkbox" id="dissue"${p.closeIssue ? ' checked' : ''}><span>Cerrar también el issue #${esc(issue)} <kbd>I</kbd><small>Si queda abierto, ronin lo bloquea y avisa: se queda sin PR para seguir.</small></span></label>` : ''}${err}
      <footer><span class="m"><kbd>Ctrl ↵</kbd> cierra · <kbd>Esc</kbd></span><button class="btn-s" data-dcancel>Cancelar</button><button class="btn-s danger-solid" data-dsend${busy}>Cerrar el PR</button></footer></div>`;
  }
  const how = n
    ? `Se manda una revisión con ${oneOr(n, 'tu comentario', `tus ${n} comentarios`)} y después <code>@${bot} /fix-comments</code> con este texto, a tu nombre.`
    : `Se comenta <code>@${bot}</code> y este texto en el PR, a tu nombre.`;
  return `<div class="drop" role="dialog" aria-label="Pedir un ajuste"><textarea id="dtext" rows="4" placeholder="¿Qué debería cambiar ronin?">${esc(p.text)}</textarea>
    <div class="quick">${DECIDE_QUICK.map((q, i) => `<button data-dquick="${i}"><kbd>${i + 1}</kbd> ${esc(q)}</button>`).join('')}</div>
    ${n ? `<div class="carry">✎ Incluye ${oneOr(n, 'tu comentario', `tus ${n} comentarios`)} de Archivos</div>` : ''}<p class="how">${how}</p>${err}
    <footer><span class="m"><kbd>Ctrl ↵</kbd> manda · <kbd>Esc</kbd></span><button class="btn-s" data-dcancel>Cancelar</button><button class="btn-s primary" data-dsend${busy || (!p.text.trim() && !n) ? ' disabled' : ''}>Mandar a ronin</button></footer></div>`;
}

function openDecide(kind) {
  const id = S.sel;
  if (!id) return;
  S.rpanel = null;
  S.menu = false;
  S.decide = S.decide?.item === id && S.decide.kind === kind ? null : { item: id, kind, text: '', closeIssue: true, sending: false, error: null };
  // The pending comments it carries.
  if (S.decide && !S.files[id]?.data) loadFiles(id);
  renderCenter();
  $('#dtext')?.focus();
}

async function sendDecision() {
  const p = S.decide;
  if (!p || p.sending) return;
  const n = pendingOf(p.item).length;
  if (p.kind === 'adjust' && !p.text.trim() && !n) return;
  p.sending = true;
  p.error = null;
  renderCenter();
  try {
    const sent = await api(`/api/items/${encodeURIComponent(p.item)}/decision`, { method: 'POST', body: JSON.stringify({ decision: p.kind, text: p.text, closeIssue: p.closeIssue }) });
    S.decide = null;
    S.decided[p.item] = { at: Date.now(), kind: p.kind, url: sent.url, autoMerge: Boolean(sent.autoMergeUrl), issue: Boolean(sent.issueUrl), count: n };
    toast(p.kind === 'approve' ? 'Aprobaste el PR.' : p.kind === 'adjust' ? 'Se lo mandaste a ronin.' : 'Cerraste el PR.', sent.url);
    afterFilesWrite(p.item);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    p.sending = false;
    p.error = `No se pudo: ${error.message}`;
    renderCenter();
  }
}

function wireDecide() {
  for (const button of document.querySelectorAll('[data-decide]')) button.onclick = (event) => {
    event.stopPropagation();
    openDecide(button.dataset.decide);
  };
  const p = S.decide;
  if (!p) return;
  for (const button of document.querySelectorAll('[data-dcancel]')) button.onclick = () => { S.decide = null; renderCenter(); };
  for (const button of document.querySelectorAll('[data-dsend]')) button.onclick = sendDecision;
  const text = $('#dtext');
  if (text) {
    text.oninput = () => {
      p.text = text.value;
      const send = $('[data-dsend]');
      if (send && p.kind === 'adjust' && !p.sending) send.disabled = !p.text.trim() && !pendingOf(p.item).length;
    };
  }
  const issue = $('#dissue');
  if (issue) issue.onchange = () => { p.closeIssue = issue.checked; };
  for (const button of document.querySelectorAll('[data-dquick]')) button.onclick = () => addDecideQuick(Number(button.dataset.dquick));
}

function addDecideQuick(i) {
  const p = S.decide;
  p.text = `${p.text.trim() ? `${p.text.replace(/\s+$/, '')}\n` : ''}${DECIDE_QUICK[i]}.`;
  renderCenter();
  focusDecideText();
}

function focusDecideText() {
  const text = $('#dtext');
  text?.focus();
  text?.setSelectionRange(text.value.length, text.value.length);
}

// The keys of an open adjustment or closing, with the focus off its text: 1–3
// a suggestion, I the issue's box, Ctrl ↵ sends. Any other key goes back to
// the text and is typed there, so nothing typed lands somewhere else.
function decideKey(event) {
  const p = S.decide;
  const text = $('#dtext');
  if (!p || p.kind === 'approve' || p.sending || !text || p.item !== S.sel) return false;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendDecision();
    return true;
  }
  const at = document.activeElement;
  if (at === text || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return false;
  // A button or the box of the dropdown keep their space.
  if (event.key === ' ' && at?.closest?.('.drop')) return false;
  if (p.kind === 'adjust' && DECIDE_QUICK[Number(event.key) - 1]) {
    event.preventDefault();
    addDecideQuick(Number(event.key) - 1);
    return true;
  }
  if (p.kind === 'close' && event.key.toLowerCase() === 'i' && $('#dissue')) {
    event.preventDefault();
    p.closeIssue = !p.closeIssue;
    $('#dissue').checked = p.closeIssue;
    return true;
  }
  focusDecideText();
  return true;
}

// ---------- moving around an item's page with the keyboard (#195)
// As in vim where it fits: j/k the next unit of the tab (a section, a
// comment; a file and a finding have their own), d/u half a page, gg/G the
// top and the bottom. The digits go to a tab, and ]p/[p to the next PR that
// waits on a decision. Two-key sequences wait a moment for their second key.
const KEY_SEQ_MS = 900;
const seq = { key: null, timer: 0 };
const UNITS = { pr: '.page .psec, .page .md > :is(h1, h2, h3), .conv .comments > article', issue: '.page .md > :is(h1, h2, h3), .conv .comments > article' };

// A PR of ronin's that's ready for someone to decide: open, not a draft,
// nobody approved it yet and no agent is on it.
function awaitsDecision(item) {
  const pr = item.pr;
  return Boolean(pr && S.snap?.ronin) && sameLogin(pr.author, S.snap.ronin) && !pr.isDraft && pr.reviewDecision !== 'APPROVED' && item.status !== 'running';
}

// In the sidebar's order: repo by repo, as listed (renderTree). From where
// the page is, so one just decided (no longer waiting) still moves on.
function movePr(step) {
  const listed = (S.snap?.repos ?? []).flatMap((repo) => (S.snap?.items ?? []).filter((i) => i.repo === repo && i.listed && i.status !== 'blocked'));
  // A ronin PR is listed as its issue: its own page is the issue's too.
  const here = (i) => i.id === S.sel || (i.pr && `${i.repo}#${i.pr.number}` === S.sel);
  const at = listed.findIndex(here);
  for (let k = 1; k <= listed.length; k++) {
    const i = listed[((at < 0 ? (step > 0 ? -1 : 0) : at) + step * k + listed.length * k) % listed.length];
    if (awaitsDecision(i) && !here(i)) return select(i.id);
  }
  toast('Ningún otro PR de ronin espera una decisión.');
}

function moveUnit(item, tab, step) {
  const all = UNITS[tab] ? [...document.querySelectorAll(`#doc :is(${UNITS[tab]})`)] : [];
  const scroller = $('#doc');
  if (!all.length) return scroller?.scrollBy({ top: step * 80 });
  const key = docKeyOf(item);
  const at = S.kunit?.key === key ? Math.min(S.kunit.i, all.length - 1) : -1;
  const i = Math.max(0, Math.min(all.length - 1, at < 0 ? (step > 0 ? 0 : all.length - 1) : at + step));
  S.kunit = { key, i };
  const next = all[i];
  markUnit();
  next.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// The unit j/k is on, marked again after the page is redrawn.
function markUnit() {
  const item = S.sel && itemById(S.sel);
  const tab = item && docOf(item);
  if (!tab || !UNITS[tab]) return;
  const all = [...document.querySelectorAll(`#doc :is(${UNITS[tab]})`)];
  const on = S.kunit?.key === docKeyOf(item) ? all[S.kunit.i] : null;
  for (const el of all) el.classList.toggle('kcur', el === on);
}

// True when the key was one of these.
function navigate(event, item) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const prev = seq.key;
  seq.key = null;
  clearTimeout(seq.timer);
  if ((prev === ']' || prev === '[') && event.key === 'p') {
    event.preventDefault();
    movePr(prev === ']' ? 1 : -1);
    return true;
  }
  if (event.key === ']' || event.key === '[') {
    seq.key = event.key;
    seq.timer = setTimeout(() => { seq.key = null; }, KEY_SEQ_MS);
    return true;
  }
  const d = item && S.detail[item.id]?.data;
  if (!item || !d || item.kind === 'other' || viewOf(item) !== 'ficha') return false;
  const tab = docOf(item);
  const scroller = tab === 'files' ? $('#fdiffs') : $('#doc');
  if (prev === 'g' && event.key === 'g') {
    event.preventDefault();
    scroller?.scrollTo({ top: 0 });
    return true;
  }
  if (event.key === 'g') {
    seq.key = 'g';
    seq.timer = setTimeout(() => { seq.key = null; }, KEY_SEQ_MS);
    return true;
  }
  if (event.key === 'G') {
    event.preventDefault();
    scroller?.scrollTo({ top: scroller.scrollHeight });
    return true;
  }
  if (event.key === 'd' || event.key === 'u') {
    event.preventDefault();
    scroller?.scrollBy({ top: (event.key === 'd' ? 1 : -1) * scroller.clientHeight / 2 });
    return true;
  }
  const tabs = docTabsOf(item, d);
  if (/^[1-9]$/.test(event.key) && tabs[Number(event.key) - 1]) {
    event.preventDefault();
    S.doc[item.id] = tabs[Number(event.key) - 1][0];
    renderCenter();
    return true;
  }
  if ((event.key === 'j' || event.key === 'k') && tab !== 'files' && tab !== 'fichas') {
    event.preventDefault();
    moveUnit(item, tab, event.key === 'j' ? 1 : -1);
    return true;
  }
  return false;
}

const KEYS_HELP = [
  ['Moverse', [['1 – 9', 'Ir a una pestaña'], ['j / k', 'Siguiente / anterior sección, comentario, archivo o ficha'], ['d / u', 'Media página abajo / arriba'], ['gg / G', 'Al inicio / al final'], [']p / [p', 'Siguiente / anterior PR de ronin que espera una decisión']]],
  ['En un PR de ronin', [['A', 'Aprobar: aprueba y mergea (↵ confirma)'], ['P', 'Ajustar: le pide un cambio a ronin (Ctrl ↵ manda)'], ['X', 'Cerrar el PR (Ctrl ↵ confirma)'], ['1 – 3', 'Fuera del texto del ajuste: sumar una sugerencia'], ['I', 'Fuera del texto del cierre: cerrar también el issue, o no']]],
  ['Acciones', [['M', 'Abrir o cerrar el menú de acciones'], ['1 – 9', 'En el menú: pedir esa acción'], ['j / k', 'En el menú: la siguiente / anterior (también ↓ ↑, y ↵ la pide)'], ['Ctrl ↵', 'En el diálogo de la acción: comentar']]],
  ['En Archivos', [['v', 'Marcar el archivo como visto'], ['r', 'Revisión, en los PRs de personas']]],
  ['General', [['?', 'Esta ayuda'], ['Esc', 'Cerrar lo que esté abierto']]],
];
function toggleKeysHelp() {
  if ($('#keys-help')) return $('#keys-help').remove();
  const el = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'keys-help', className: 'scrim' });
  const keys = (k) => k.split(' ').map((x) => (/^[/–]$/.test(x) ? x : `<kbd>${esc(x)}</kbd>`)).join(' ');
  el.innerHTML = `<div class="dlg keys-dlg" role="dialog" aria-modal="true" aria-labelledby="keys-t"><h2 id="keys-t">Atajos</h2>${KEYS_HELP.map(([h, rows]) => `<h3>${esc(h)}</h3><dl>${rows.map(([k, what]) => `<dt>${keys(k)}</dt><dd>${esc(what)}</dd>`).join('')}</dl>`).join('')}</div>`;
  el.onclick = (event) => { if (event.target === el) el.remove(); };
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

// The panel drops from the button that opened it: the page's head or the
// Archivos toolbar.
const revOpen = (item, at) => S.rpanel?.item === item.id && S.rpanel.at === at;
const reviewButton = (item, at, button) => `<div class="actions rwrap">${button}${reviewPanelHTML(item, at)}</div>`;

function openReviewPanel(at) {
  const id = S.sel;
  if (!id) return;
  S.rpanel = S.rpanel?.item === id && S.rpanel.at === at ? null : { item: id, at, event: 'COMMENT', text: '', fix: true, autoMerge: true, sending: false, error: null };
  if (S.rpanel && !S.files[id]?.data) loadFiles(id);
  renderCenter();
  if (S.rpanel) $('#rsum')?.focus();
}

function reviewPanelHTML(item, at) {
  const p = S.rpanel;
  if (!p || p.item !== item.id || p.at !== at) return '';
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
  const merge = autoMergeChoice(event, d, fixable && p.fix);
  const am = merge === 'offer' || merge === 'with-fix'
    ? `<label class="rfix${merge === 'with-fix' ? ' off' : ''}"><input type="checkbox" id="ram"${merge === 'offer' && p.autoMerge ? ' checked' : ''}${merge === 'with-fix' ? ' disabled' : ''}><span><b>Mergear apenas pasen los checks</b><small>${merge === 'with-fix'
      ? 'No junto con /fix-comments: se mergearía antes de que ronin los atienda. Pedí el auto-merge cuando estén.'
      : `Después de aprobar comenta <code>@${esc(d.ronin)} /auto-merge</code> a tu nombre (el label <code>ronin:auto-merge</code>).`}</small></span></label>`
    : '';
  const where = (t) => `${t.path.split('/').pop()}${t.subject === 'file' ? '' : t.line ? ` · línea ${t.line}` : ''}`;
  const list = pend.length
    ? pend.map(({ t, c }) => `<button class="ri" data-rjump="${esc(t.path)}|${esc(c.nodeId)}"><span class="w">${esc(where(t))}${t.isNew ? '' : ' · respuesta'}</span><span class="t">${esc(c.body.replace(/```suggestion[\s\S]*?```/g, '[cambio sugerido]').trim().split('\n')[0])}</span></button>`).join('')
    : '<p class="m">Ningún comentario todavía: hacé clic en el número de una línea en Archivos.</p>';
  const can = !p.sending && (event !== 'COMMENT' || pend.length > 0 || p.text.trim());
  return `<div class="rpanel" role="dialog" aria-label="Terminar la revisión">${head}<div class="rbody">
    <textarea id="rsum" rows="3" placeholder="Resumen (opcional). Va arriba de la revisión, como en GitHub.">${esc(p.text)}</textarea>
    <div class="rev">${options}</div>${fix}${am}
    <div class="rlist"><div class="rh">En tu revisión<span>${pend.length ? `${pend.length} comentario${pend.length === 1 ? '' : 's'}` : ''}</span></div>${list}</div></div>
    <footer>${p.error ? `<span class="bad">${esc(p.error)}</span>` : `<span class="m">${pend.length ? 'Hasta mandarla, nadie ve tus comentarios.' : ''}</span>`}${reviewOf(item.id) ? `<button class="btn-s danger" data-rdiscard${p.sending ? ' disabled' : ''}>Descartar</button>` : ''}<button class="btn-s primary" data-rsend${can ? '' : ' disabled'}>${p.sending ? 'Enviando…' : 'Mandar revisión'}</button></footer></div>`;
}

// Whether approving offers the auto-merge: only to approve, on a PR that
// doesn't have it yet, isn't a draft (ronin doesn't read commands on a
// human's draft) and doesn't conflict (the command would refuse it), and
// never along with /fix-comments.
function autoMergeChoice(event, d, withFix) {
  if (event !== 'APPROVE' || !d?.ronin || !d.pr || d.pr.isDraft || d.pr.mergeable === 'CONFLICTING' || d.pr.labels?.includes('ronin:auto-merge')) return null;
  return withFix ? 'with-fix' : 'offer';
}

function wireReviewPanel() {
  const p = S.rpanel;
  if (!p) return;
  // Under the Archivos toolbar it lives inside the diffs' scroller: it ends
  // where that ends, not past it.
  const panel = $('.rpanel');
  if (panel && getComputedStyle(panel).position === 'absolute') {
    const bottom = panel.closest('.fdiffs')?.getBoundingClientRect().bottom ?? window.innerHeight;
    panel.style.maxHeight = `${Math.max(240, bottom - panel.getBoundingClientRect().top - 12)}px`;
  }
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
  if (fix) fix.onchange = () => { p.fix = fix.checked; renderCenter(); };
  const am = $('#ram');
  if (am) am.onchange = () => { p.autoMerge = am.checked; };
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

// An approval or a request for changes shows on the PR's chips at once,
// until a snapshot brings a read of the repo newer than the one at hand when
// it was sent (the server reads it again right after); a couple of minutes
// at most, if that read never comes.
const REVIEW_DECISION = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' };
const REVIEW_SHOWN_MS = 120_000;
const repoReadAt = (repo) => S.snap?.github?.find((g) => g.repo === repo)?.fetchedAt ?? null;

function showSentReviews() {
  for (const [key, sent] of Object.entries(S.revSent)) {
    if (repoReadAt(sent.repo) !== sent.readAt || Date.now() - sent.at > REVIEW_SHOWN_MS) {
      delete S.revSent[key];
      continue;
    }
    for (const item of [...(S.snap?.items ?? []), ...Object.values(S.extra)]) {
      if (item.repo === sent.repo && item.pr?.number === sent.pr) item.pr.reviewDecision = sent.decision;
    }
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
  const autoMerge = autoMergeChoice(event, d, fixable && p.fix) === 'offer' && p.autoMerge;
  p.sending = true;
  p.error = null;
  renderCenter();
  try {
    const sent = await filesAction(p.item, { action: 'submit', event, text: p.text, commitId: data.headSha, fixComments: Boolean(fixable && p.fix), autoMerge });
    S.rpanel = null;
    const item = itemById(p.item);
    if (item && REVIEW_DECISION[event]) {
      S.revSent[`${item.repo}#${data.pr}`] = { repo: item.repo, pr: data.pr, decision: REVIEW_DECISION[event], readAt: repoReadAt(item.repo), at: Date.now() };
      showSentReviews();
      renderTree();
      renderCenter();
    }
    toast(`${REVIEW_SENT[event]}${sent.fixUrl ? '; ronin ya tiene el /fix-comments' : ''}${sent.autoMergeUrl ? ' y le pediste el auto-merge' : ''}.`, sent.url);
    afterFilesWrite(p.item);
    refresh();
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    openReviewPanel(button.dataset.frev);
  };
  wireReviewPanel();
  wireDecide();
  for (const button of document.querySelectorAll('[data-keys]')) button.onclick = toggleKeysHelp;
  markUnit();
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
// answers a first comment, or a reply that mentions it. Once ronin answered
// (applied the changes asked for), it can be marked to approve again.
function fichaStatus(f, ronin, id) {
  if (f.estado === 'rechazado') return 'rechazada';
  if (f.estado === 'aprobado') return 'aprobada';
  const marked = id && listas(id).has(fichaKey(f));
  const last = f.comments[f.comments.length - 1];
  if (!last) return marked ? 'lista' : 'decidir';
  if (last.author !== ronin && (!last.replyTo || RONIN_MENTION.test(last.body))) return 'esperando';
  return marked ? 'lista' : 'respondida';
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
  const old = S.oldAfter.has(key) && f.previousAfterImage;
  const after = f.despues && (old ? f.previousAfterImage : f.despues);
  const thumbs = f.antes.length > 1 ? `<span class="thumbs">${f.antes.map((a, k) => {
    const local = evidenceSrc(a.url);
    return `<button class="thumb" data-antes="${k}" aria-pressed="${k === i}" title="${esc(a.nota ?? `Antes ${k + 1}`)}">${local ? `<img class="ev" src="${esc(local)}" alt="" data-label="${k + 1}">` : k + 1}</button>`;
  }).join('')}</span>` : '';
  const before = f.antes[i];
  if (!before && !after) return '';
  const afterExtra = f.previousAfterImage ? `<button class="link tag" data-oldafter>${old ? 'ver la actual' : 'ver la anterior'}</button>` : '';
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
  return `<span class="decide">${status !== 'esperando' ? `<button class="btn-s ok" data-flista aria-pressed="${marked}" title="${marked ? 'Se aprueba cuando apruebes el PR. Clic para deshacer.' : 'Queda para aprobar: se aprueba cuando apruebes el PR.'}">${marked ? '✓ Para aprobar' : '✓ Aprobar'} <kbd>a</kbd></button>` : ''}
    <button class="btn-s" data-fact="cambios">Pedir cambios <kbd>c</kbd></button>
    <button class="btn-s danger" data-fact="rechazar">Rechazar <kbd>r</kbd></button>
    <span class="actions"><button class="btn-s" id="fmore" aria-haspopup="menu" aria-expanded="${S.fmenu}">Más ▾</button>${menu}</span></span>`;
}

function fichaHTML(item, data, f, shown) {
  const status = fichaStatus(f, data.ronin, item.id);
  const idx = shown.findIndex((x) => fichaKey(x) === fichaKey(f));
  // Who decided it in the review, and when (their GitHub login).
  const by = f.revisor ? ` <span class="m">por ${esc(f.revisor)}${f.revisado ? `, hace ${short(Date.now() - Date.parse(f.revisado))}` : ''}</span>` : '';
  const banner = {
    rechazada: `<div class="banner crit">${dotClass('crit')}<div><b>Rechazada</b>${by}${f.motivo ? `<p>${esc(f.motivo)}</p>` : ''}</div></div>`,
    aprobada: `<div class="banner ok">${dotClass('ok')}<div><b>Aprobada</b>${by}${f.issue ? `<p>Issue <a href="${esc(`https://github.com/${item.repo}/issues/${f.issue}`)}" target="_blank" rel="noopener">#${esc(f.issue)}</a>.</p>` : ''}</div></div>`,
    esperando: `<div class="banner run">${dotClass('live')}<div><b>Esperando a ronin</b><p>Hay un comentario que ronin todavía no respondió. Cuando lo aplique, su respuesta aparece abajo.</p></div></div>`,
  }[status] ?? '';
  const meta = [f.senal && f.senal !== f.gravedad && f.tipo !== 'idea' ? esc(f.senal) : '', `rol ${esc(f.rol)}`, esc(f.functionName || f.funcion), f.entorno ? 'entorno de dev' : '', f.revisor && f.estado === 'propuesto' ? `editada por ${esc(f.revisor)}` : ''].filter(Boolean).map((m) => `<span>${m}</span>`).join('');
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
  const url = `${itemPath(S.sel)}?f=${encodeURIComponent(key)}`;
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
  const after = f.despues && (S.oldAfter.has(key) && f.previousAfterImage ? f.previousAfterImage : f.despues);
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
  approve: { pr: true, optional: true, title: 'Finalizar la revisión', field: 'Comentario de la review (opcional)', btn: 'Finalizar', placeholder: 'Por ejemplo: las de catálogos van primero' },
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
// an issue assigned to ronin, the rejected ones, those nobody decided on and those ronin is
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
  return `<div class="sum"><p class="sumh">${dotClass('ok')}Abren su issue y ronin los empieza (${keep.length})</p>${keep.length ? `<ul>${keep.map(li).join('')}</ul>` : ''}
    <p class="sumh">${dotClass('crit')}Rechazadas, sin issue (${rejected.length})</p>${rejected.length ? `<ul>${rejected.map(li).join('')}</ul>` : ''}
    ${undecided.length ? `<p class="warnbox">${undecided.length === 1 ? 'Queda 1 ficha' : `Quedan ${undecided.length} fichas`} sin revisar (${esc(undecided.map((f) => f.id).join(', '))}). Si finalizás, también abren su issue y ronin los empieza.</p>` : ''}
    ${waiting.length ? `<p class="warnbox">ronin todavía está aplicando comentarios en ${esc(waiting.map((f) => f.id).join(', '))}. Finalizá cuando responda.</p>` : ''}
    <p class="help">Se envía como tu review <b>Approve</b> en GitHub. Con eso ronin marca las fichas, abre un issue por cada una que siga en pie, se lo asigna y mergea el PR. Cada issue arranca como uno asignado a mano.</p></div>`;
}
const waitingCount = (itemId) => {
  const data = S.expl[itemId]?.data;
  return data ? data.fichas.filter((f) => fichaStatus(f, data.ronin, itemId) === 'esperando').length : 0;
};

// The comment as it will be written — the same words the server writes
// (explorations/review-actions.ts's fichaComment).
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
  yes.textContent = d.sending ? (d.action === 'approve' ? 'Finalizando…' : 'Comentando…') : meta.btn;
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
  toast(d.action === 'approve' ? `Finalizaste la revisión del PR #${d.pr}. ronin marca las fichas, abre sus issues y lo mergea.` : `Comentaste en el PR #${d.pr}. ronin lo va a aplicar y te responde ahí.`, done.url);
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
  if (status === 'esperando') return;
  setLista(item.id, fichaKey(f), status !== 'lista');
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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

function closeTab(id) {
  S.open = S.open.filter((x) => x !== id);
  if (S.sel === id) {
    if (S.open[0]) select(S.open[0]);
    else {
      S.sel = null;
      S.page = null;
      stopStream();
      history.pushState(null, '', '/');
      renderAll();
    }
  } else renderCenter();
}

function wireCenter() {
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => select(button.dataset.tab);
  for (const button of document.querySelectorAll('[data-goped]')) button.onclick = () => openPedido(Number(button.dataset.goped));
  for (const button of document.querySelectorAll('#center [data-xpl-page]')) button.onclick = () => openExploraciones();
  wireXpl();
  for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => closeTab(button.dataset.close);
  // The wheel's click closes a tab, as in a browser; holding it down there
  // doesn't start the browser's autoscroll.
  for (const tab of document.querySelectorAll('.tabs .tab')) {
    const id = tab.querySelector('[data-close]')?.dataset.close;
    tab.onmousedown = (event) => { if (event.button === 1) event.preventDefault(); };
    tab.onauxclick = (event) => {
      if (event.button !== 1 || !id) return;
      event.preventDefault();
      closeTab(id);
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

// ---------- today: pages/today in React (#235, stage 7)
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

// ---------- explorations (#155)
// One row per app a repo explores, from the snapshot; the list
// (/api/explorations) adds its exploration PR's findings counted, the last
// run and the next. An app's page is its repo's exploration PR's page (#93),
// headed as the app's; with no PR open, a page of its own until ronin opens one.
const XPL_EVERY_MS = 60_000;
const xplRows = () => S.snap?.exploraciones ?? [];
const xplKey = (r) => `${r.repo}|${r.app}`;
const splitXplKey = (key) => key.split('|');
const xplRow0 = (repo, app) => xplRows().find((r) => r.repo === repo && r.app === app) ?? null;
const xplListRow = (r) => S.xpl.list?.find((x) => x.repo === r.repo && x.app === r.app) ?? null;
const xplCounts = (r) => xplListRow(r)?.fichas ?? null;
const xplToDecide = () => xplRows().reduce((n, r) => n + (xplCounts(r)?.decidir ?? 0), 0);
const xplPath = (repo, app) => `/exploraciones/${repo}/${encodeURIComponent(app)}`;
// The app whose page an item is: its repo's exploration PR, the app open
// now when the repo explores more than one.
function xplOfItem(id) {
  const rows = xplRows().filter((r) => r.pr?.id === id);
  return rows.find((r) => r.repo === S.xpl.repo && r.app === S.xpl.app) ?? rows[0] ?? null;
}
function itemPath(id) {
  const xr = xplOfItem(id);
  return xr ? xplPath(xr.repo, xr.app) : `/i/${encodeURIComponent(id)}`;
}

// The nightly run: right now while the window is open and the app didn't start yet.
const xplNext = (iso) => (!iso ? '' : Date.parse(iso) <= Date.now() + MIN ? 'esta noche, en cuanto haya lugar' : when(iso));

function xplChip(r) {
  if (r.running) return `<span class="chip run">explorando${r.running.fn ? ` ${esc(r.running.fn)}` : ''}</span>`;
  if (xplStarting(r)) return '<span class="chip run">arrancando…</span>';
  if (!r.pr) return '<span class="chip idle">sin PR de exploración</span>';
  const c = xplCounts(r);
  if (!c) return '<span class="chip idle">PR abierto</span>';
  if (c.decidir) return `<span class="chip warn">${c.decidir} ${c.decidir === 1 ? 'ficha' : 'fichas'} por decidir</span>`;
  if (c.esperando) return '<span class="chip run">esperando a ronin</span>';
  return '<span class="chip ok">nada por decidir</span>';
}

function xplFacts(r) {
  const l = xplListRow(r);
  const facts = [];
  if (r.running) facts.push(`desde las ${hhmm(r.running.since)}`);
  else if (l?.lastRun) facts.push(`última corrida ${ago(l.lastRun.at)}${l.lastRun.state === 'ok' ? '' : `, ${STATE[l.lastRun.state]?.[2] ?? l.lastRun.state}`}`);
  if (l?.next) facts.push(`próxima: ${xplNext(l.next)}`);
  return facts;
}

function xplHead(r, buttons, pill) {
  return `<div class="head">
    <div class="crumb"><button class="crumb-l" data-xpl-page>Exploraciones</button><span>/</span><i style="background:${repoColor(r.repo)}"></i>${esc(r.repo)}</div>
    <div class="row"><h1>${esc(r.app)}</h1>${buttons}${xplNowButton(r)}</div>
    <div class="state">${pill}${xplChip(r)}${xplFacts(r).map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>`;
}

// The head of the exploration PR's page, as its app's (#155).
function xplHeadHTML(item, r) {
  const d = S.detail[item.id]?.data;
  const url = githubUrl(item);
  const buttons = `${url ? `<a class="gh" href="${esc(url)}" target="_blank" rel="noopener">PR #${item.number} ↗</a>` : ''}${d?.exploration ? '<button class="gh" data-xpr="general">Comentario general</button>' : ''}${actionsHTML(d)}${d?.exploration ? '<button class="act-btn" data-xpr="approve" title="Termina la revisión: aprueba las fichas que quedan y mergea el PR">Finalizar…</button>' : ''}`;
  return xplHead(r, buttons, ghPill(item, d));
}

function xplListHTML() {
  const head = `<div class="reu-top"><div><h1>Exploraciones</h1><p class="lead">ronin usa cada app como lo haría un QA: encuentra dónde duele y propone cómo mejorarlo, con el antes y el después. Corre de noche, o con <code>/explore &lt;app&gt;</code> en un issue. Las fichas se revisan aquí, y ninguna abre su issue hasta que apruebes el PR.</p></div></div>`;
  const rows = xplRows().map((r) => {
    const l = xplListRow(r);
    return `<tr data-xpl="${esc(xplKey(r))}" tabindex="0"><td><span class="tt">${esc(r.app)}</span><small>${esc(r.repo)}</small></td>
      <td>${xplChip(r)}${r.running?.step ? `<small>${esc(r.running.step)}</small>` : ''}</td>
      <td class="hide-m">${r.pr ? `<span class="pd-gh">#${r.pr.number}</span>${l?.fichas ? `<small>${l.fichas.total} ${l.fichas.total === 1 ? 'ficha' : 'fichas'}</small>` : ''}` : '<small>se abre con la primera ficha</small>'}</td>
      <td class="hide-m m">${l?.lastRun ? esc(ago(l.lastRun.at)) : '—'}${l?.next ? `<small>próxima: ${esc(xplNext(l.next))}</small>` : ''}</td></tr>`;
  }).join('');
  return `<div class="today pd">${head}${S.xpl.error ? `<p class="bad">${esc(S.xpl.error)}</p>` : ''}
    <table class="padm-t pd-t"><thead><tr><th>App</th><th>Estado</th><th class="hide-m">PR de exploración</th><th class="hide-m">Última corrida</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// An app with no exploration PR open.
function xplAppHTML() {
  const r = xplRow0(S.xpl.repo, S.xpl.app);
  if (!r) return `<div class="today pd"><p class="bad">Ningún repo de ronin explora la app ${esc(S.xpl.app ?? '')}.</p></div>`;
  const tab = S.xpl.tab === 'inventario' ? 'inventario' : 'corridas';
  const bar = `<div class="doctabs" role="tablist">${[['corridas', 'Corridas'], ['inventario', 'Inventario']].map(([k, label]) => `<button class="doctab" role="tab" data-xtab="${k}" aria-selected="${k === tab}">${label}</button>`).join('')}</div>`;
  return xplHead(r, '', '') + bar + `<div class="doc" id="doc" data-key="${esc(`${xplKey(r)}:${tab}`)}"><div class="xpl-doc"><div class="pd-card xpl-empty"><h3>Sin PR de exploración</h3>
    <p>Se abre con la primera ficha que ronin proponga para ${esc(r.app)}, y las corridas siguientes se suman al mismo PR hasta que lo apruebes.${r.running ? ' La corrida de ahora puede abrirlo.' : ''}</p></div>
    ${tab === 'inventario' ? xplInventarioHTML(r) : xplCorridasHTML(r)}</div></div>`;
}

// ---------- an app's runs and inventory (#155, 2/4)
// Read when their tab is shown, and again once old: the runs often (one may
// be going), the inventory seldom (it changes once per run).
const XPL_PART = { cor: ['runs', PEDIDO_EVERY_MS], inv: ['inventory', XPL_EVERY_MS] };

async function loadXplPart(bucket, r) {
  const entry = (S.xpl[bucket][xplKey(r)] ??= {});
  if (entry.loading) return;
  entry.loading = true;
  try {
    entry.data = await api(`/api/explorations/${r.repo}/${encodeURIComponent(r.app)}/${XPL_PART[bucket][0]}`);
    entry.error = null;
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  if (S.page === 'exploracion') renderCenter();
}

function xplPart(bucket, r) {
  const entry = S.xpl[bucket][xplKey(r)];
  if (!entry || (!entry.loading && Date.now() - (entry.at ?? 0) > XPL_PART[bucket][1])) queueMicrotask(() => loadXplPart(bucket, r));
  return entry;
}

async function loadXplRun(runId) {
  try {
    const { summary, lines } = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (S.xpl.run?.runId !== runId) return;
    S.xpl.run = { runId, summary, lines: lines.filter((line) => line.type !== 'run_start' && line.type !== 'run_end') };
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    if (S.xpl.run?.runId === runId) S.xpl.run.error = error.message;
  }
  if (S.page === 'exploracion') renderCenter();
}

const XPL_TRIGGER = { noche: 'de noche', manual: 'a pedido', desconocido: 'sin registro' };
const xplTrigger = (t) => (t.kind === 'issue' ? `/explore en #${t.issueNumber}` : t.kind === 'manual' && t.by ? `a pedido de ${t.by}` : XPL_TRIGGER[t.kind] ?? t.kind);
const XPL_STATE = { running: ['live', 'en curso'], ok: ['ok', 'terminó bien'], error: ['crit', 'falló'], cut: ['crit', 'se cortó'] };
const agentName = (a) => `${typeName(a.taskType)}${a.fn ? ` ${a.fn}` : ''}`;

function corridaHTML(c) {
  const [tone, said] = XPL_STATE[c.state] ?? XPL_STATE.error;
  const took = c.state === 'running' ? `<span data-since="${esc(c.startedAt)}"></span>` : c.endedAt ? esc(duration(Date.parse(c.endedAt) - Date.parse(c.startedAt))) : '';
  const fns = c.functions.map((f) => `<span class="xr-fn ${f.status === 'fallo' ? 'bad' : f.status === 'omitida' ? 'off' : ''}" title="${esc([f.status, f.reason && `motivo: ${f.reason}`, f.role && `rol: ${f.role}`, f.error].filter(Boolean).join(' · '))}">${esc(f.id)}${f.charter ? ` <span class="m">${esc(f.charter)}${f.viewports?.length ? ` · ${esc(f.viewports.join(', '))}` : ''}</span>` : ''}</span>`).join('');
  const facts = [];
  if (c.findings) facts.push(c.findings.length ? `${c.findings.length} ${c.findings.length === 1 ? 'ficha' : 'fichas'}: ${c.findings.map((f) => f.id).join(', ')}` : 'ninguna ficha');
  if (c.discarded) facts.push(`${c.discarded} ${c.discarded === 1 ? 'descartada' : 'descartadas'}`);
  if (c.prNumber) facts.push(`PR #${c.prNumber}`);
  if (c.seed !== undefined) facts.push(`semilla ${c.seed}`);
  if (c.legacy) facts.push('de antes del registro de corridas: sin semilla ni fichas');
  const agents = c.agents.map((a) => `<button class="xr-ag ${S.xpl.run?.runId === a.runId ? 'cur' : ''}" data-xrun="${esc(a.runId)}">${dot(a.state)}${esc(agentName(a))}<span class="m">${a.state === 'running' ? 'en curso' : a.durationMs !== undefined ? esc(duration(a.durationMs)) : ''}</span></button>`).join('');
  return `<div class="xr"><div class="xr-h">${dotClass(tone)}<b>${esc(when(c.startedAt))}</b><span class="tag">${esc(xplTrigger(c.trigger))}</span><span class="m">${esc(said)}</span><span class="st">${took}${c.costUsd ? ` · ${esc(money(c.costUsd))}` : ''}</span></div>
    ${fns ? `<div class="xr-fns">${fns}</div>` : ''}
    ${c.error ? `<div class="xr-err">${esc(c.error)}</div>` : ''}
    ${facts.length ? `<div class="xr-f">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
    ${agents ? `<div class="xr-ags">${agents}</div>` : ''}</div>`;
}

function xplCorridasHTML(r) {
  const entry = xplPart('cor', r);
  if (!entry?.data) return `<div class="empty">${entry?.error ? `No se pudieron leer las corridas: ${esc(entry.error)}` : 'Leyendo las corridas…'}</div>`;
  const list = entry.data.corridas;
  if (!list.length) return '<p class="note">Sin corridas en los últimos 14 días.</p>';
  const open = S.xpl.run;
  const view = open ? `<div class="pd-runview"><div class="pd-runbar"><b>${esc(typeName(open.summary?.taskType ?? ''))}</b><span class="m">${open.summary ? esc(when(open.summary.startedAt)) : ''}</span><button class="btn-s" data-xrunx>Cerrar</button></div>${open.summary
    ? `<div class="tx pd-tx">${open.lines.map(step).join('') || '<div class="empty">El agente todavía no hizo nada.</div>'}${ending(open.summary)}</div>`
    : `<div class="empty">${open.error ? esc(open.error) : 'Cargando la corrida…'}</div>`}</div>` : '';
  return `${view}<div class="xr-list">${list.map(corridaHTML).join('')}</div>`;
}

function xplInventarioHTML(r) {
  const entry = xplPart('inv', r);
  if (!entry?.data) return `<div class="empty">${entry?.error ? `No se pudo leer el inventario: ${esc(entry.error)}` : 'Leyendo el inventario…'}</div>`;
  const inv = entry.data;
  const from = inv.from.pr ? `la rama del PR #${inv.from.pr}` : inv.from.branch;
  if (inv.error) return `<p class="note">${esc(inv.error)}.</p>`;
  const live = inv.funciones.filter((f) => !f.retirada && f.prioridad !== 'excluida');
  const seen = live.filter((f) => f.ultima).length;
  const pill = (f) => (f.retirada ? `<span class="xi-p off">retirada el ${esc(dayMonth(`${f.retirada}T12:00:00Z`))}</span>` : f.prioridad === 'alta' ? '<span class="xi-p hi">alta</span>' : f.prioridad === 'excluida' ? '<span class="xi-p off">excluida</span>' : !f.ultima ? '<span class="xi-p new">nunca explorada</span>' : '');
  const matrix = (f) => `<span class="xi-mx">${inv.charters.map((c) => `<i class="${f.charters[c] ? 'on' : ''}" title="${esc(c)}${f.charters[c] ? `: ${esc(f.charters[c])}` : ': todavía no'}"></i>`).join('')}</span><span class="m">${Object.keys(f.charters).length}/${inv.charters.length}</span>`;
  const rows = inv.funciones.map((f) => `<tr class="${f.retirada || f.prioridad === 'excluida' ? 'dim' : ''}"><td><span class="tt">${esc(f.nombre)}</span><small>${esc(f.rutas.join(', ') || f.id)}</small>${f.notas ? `<small>${esc(f.notas)}</small>` : ''}</td>
      <td>${pill(f)}</td><td class="hide-m m">${f.ultima ? esc(dayMonth(`${f.ultima}T12:00:00Z`)) : '—'}${f.viewports.length ? `<small>${esc(f.viewports.join(', '))}</small>` : ''}</td>
      <td>${matrix(f)}</td><td class="hide-m m">${f.hallazgos || ''}</td></tr>`).join('');
  return `<p class="xi-lead">${seen} de ${live.length} funciones exploradas al menos una vez. De <code>inventory.yml</code> en ${esc(from)}${inv.actualizado ? `, refrescado el ${esc(dayMonth(`${inv.actualizado.fecha}T12:00:00Z`))}` : ''}. Se edita en el repo.</p>
    <table class="padm-t xi-t"><thead><tr><th>Función</th><th></th><th class="hide-m">Última vez</th><th>Charters</th><th class="hide-m">Fichas</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- Explorar ahora (#155, 3/4)
// ronin still chooses the functions and the charters: the dialog only asks
// how many, for how long, and whether it stands for tonight's run.
// Launched, the app says "arrancando…" until the snapshot sees its worker.
const XPL_STARTING_MS = 3 * MIN;
const xplStarting = (r) => !r.running && S.xpl.launched[r.repo]?.app === r.app && Date.now() - S.xpl.launched[r.repo].at < XPL_STARTING_MS;
// Why it can't start now, or null: one run per repo at a time.
function xplBlocked(r) {
  const other = xplRows().find((x) => x.repo === r.repo && x.running);
  if (other) return other.app === r.app ? `ronin ya está explorando ${r.app}` : `ronin está explorando ${other.app}, del mismo repo: una por repo a la vez`;
  return Date.now() - (S.xpl.launched[r.repo]?.at ?? 0) < XPL_STARTING_MS ? 'la exploración que pediste está arrancando' : null;
}
const xplNowButton = (r) => {
  if (!canDo(r.repo, 'acciones')) return '';
  const blocked = xplBlocked(r);
  return `<button class="act-btn" data-xnow="${esc(xplKey(r))}" ${blocked ? `disabled title="${esc(blocked)}"` : ''}>Explorar ahora</button>`;
};

function openExploreNow(repo, app) {
  S.xnow = { repo, app, n: 3, hours: 2, tonight: true, sending: false, error: null };
  renderExploreNow();
}

function closeExploreNow() {
  if (S.xnow?.sending) return;
  S.xnow = null;
  renderExploreNow();
}

function renderExploreNow() {
  let layer = $('#xlayer');
  const x = S.xnow;
  if (!x) {
    layer?.remove();
    return;
  }
  const r = xplRow0(x.repo, x.app);
  if (!layer) {
    layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'xlayer' });
    layer.innerHTML = `<div class="scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="xn-t">
      <h2 id="xn-t">Explorar ${esc(x.app)} ahora</h2>
      <p class="help">ronin elige las funciones y los charters igual que de noche: primero las nuevas y las que cambiaron, después las marcadas <b>alta</b>, la que hace más tiempo que no se explora, y una al azar. ${r?.pr ? `Lo que encuentre se suma al PR #${r.pr.number}.` : 'Si encuentra algo, abre el PR de exploración.'}</p>
      <div class="xn-row"><label class="field"><span>Funciones</span><select id="xn-n">${[1, 2, 3, 4, 5, 8, 10].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <label class="field"><span>Tope de tiempo</span><select id="xn-h"><option value="1">1 hora</option><option value="2">2 horas</option><option value="4">4 horas</option><option value="">Sin tope</option></select></label></div>
      <label class="check"><input type="checkbox" id="xn-night"><span>Cuenta como la de esta noche<small id="xn-why"></small></span></label>
      <p class="help">Usa la cuenta de Claude de ${esc(repoShort(x.repo))}, la misma del trabajo de día. Corre aparte, como de noche, y queda en <i>Corridas</i> a tu nombre.</p>
      <p class="bad" id="xn-err" hidden></p>
      <div class="foot-d"><button class="btn-s" id="xn-no">Cancelar</button><button class="btn-s primary" id="xn-yes"></button></div></div></div>`;
    $('#xn-n').value = String(x.n);
    $('#xn-h').value = x.hours ? String(x.hours) : '';
    $('#xn-n').onchange = (e) => { S.xnow.n = Number(e.target.value); };
    $('#xn-h').onchange = (e) => { S.xnow.hours = e.target.value ? Number(e.target.value) : null; };
    $('#xn-night').onchange = (e) => { S.xnow.tonight = e.target.checked; renderExploreNow(); };
    $('#xn-no').onclick = closeExploreNow;
    layer.querySelector('.scrim').onclick = (event) => { if (event.target.classList.contains('scrim')) closeExploreNow(); };
    $('#xn-yes').onclick = sendExploreNow;
    $('#xn-yes').focus();
  }
  $('#xn-night').checked = x.tonight;
  $('#xn-why').textContent = x.tonight ? 'Esta noche no corre otra de esta app: el límite semanal de Claude es el mismo que usa el trabajo de día.' : 'Esta noche corre otra igual, con otras funciones.';
  const yes = $('#xn-yes');
  yes.textContent = x.sending ? 'Lanzando…' : 'Explorar';
  yes.disabled = x.sending;
  $('#xn-err').hidden = !x.error;
  $('#xn-err').textContent = x.error ?? '';
}

async function sendExploreNow() {
  const x = S.xnow;
  if (!x || x.sending) return;
  x.sending = true;
  x.error = null;
  renderExploreNow();
  try {
    const done = await api(`/api/explorations/${x.repo}/${encodeURIComponent(x.app)}/run`, { method: 'POST', body: JSON.stringify({ maxFunctions: x.n, hours: x.hours, tonight: x.tonight }) });
    S.xpl.launched[x.repo] = { app: x.app, at: Date.now() };
    S.xnow = null;
    renderExploreNow();
    toast(`ronin está levantando ${x.app} para explorarla${done.until ? ` hasta las ${hhmm(done.until)}` : ''}.${done.night ? ' Esta noche no corre otra.' : ''} La corrida se sigue en Corridas.`);
    S.xpl.cor = {};
    await refresh();
    loadExploraciones();
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    x.sending = false;
    x.error = `No se pudo: ${error.message}`;
    renderExploreNow();
  }
}

function wireXpl() {
  const center = $('#center');
  for (const row of center.querySelectorAll('[data-xpl]')) {
    const go = () => openExploracion(...splitXplKey(row.dataset.xpl));
    row.onclick = go;
    row.onkeydown = (event) => { if (event.key === 'Enter') go(); };
  }
  for (const b of center.querySelectorAll('[data-xtab]')) b.onclick = () => { S.xpl.tab = b.dataset.xtab; renderCenter(); };
  for (const b of center.querySelectorAll('[data-xnow]')) b.onclick = () => openExploreNow(...splitXplKey(b.dataset.xnow));
  for (const b of center.querySelectorAll('[data-xrun]')) {
    b.onclick = () => {
      S.xpl.run = { runId: b.dataset.xrun };
      renderCenter();
      $('#doc')?.scrollTo(0, 0);
      loadXplRun(b.dataset.xrun);
    };
  }
  center.querySelector('[data-xrunx]')?.addEventListener('click', () => { S.xpl.run = null; renderCenter(); });
}

async function loadExploraciones() {
  // Taken before asking, so the snapshots meanwhile don't ask again.
  S.xpl.listAt = Date.now();
  try {
    S.xpl.list = (await api('/api/explorations')).apps;
    S.xpl.error = null;
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    S.xpl.error = error.message;
  }
  renderQuick();
  renderTree();
  if (['exploraciones', 'exploracion'].includes(S.page)) renderCenter();
}

function openExploraciones() {
  S.sel = null;
  S.page = 'exploraciones';
  stopStream();
  if (location.pathname !== '/exploraciones') history.pushState(null, '', '/exploraciones');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadExploraciones();
}

// `ficha`: the finding to open, from the URL (?f=).
function openExploracion(repo, app, ficha) {
  if (S.xpl.repo !== repo || S.xpl.app !== app) S.xpl.run = null;
  Object.assign(S.xpl, { repo, app });
  const r = xplRow0(repo, app);
  if (r?.pr) {
    if (ficha) {
      S.ficha[r.pr.id] = ficha;
      S.fichaOpen[r.pr.id] = true;
    }
    select(r.pr.id);
    return;
  }
  S.sel = null;
  S.page = 'exploracion';
  stopStream();
  const path = xplPath(repo, app);
  if (location.pathname !== path) history.pushState(null, '', path);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  loadExploraciones();
}

// ---------- the portal's requests (#132)
// What people ask through the portal and where each request stands. The
// pages are in React (src/apps/dashboard/src/pages/requests/): this routes
// to them, keeps what the sidebar shows of a request, and draws a request's
// issue and PR as their page does (PAGE_HOST.requestDoc).
const PED_CLOSED = ['done', 'resolved', 'declined', 'cancelled'];
// The timeline's icons, which a meeting's page shares.
const PED_ICON = {
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  ronin: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  run: '<svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  crit: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
};
const firstName = (name) => String(name ?? '').split(' ')[0];
const ago = (iso) => (iso ? `hace ${short(Date.now() - Date.parse(iso))}` : '');

// Who a request waits on, in the sidebar's row.
function waitsLabel(p) {
  const who = firstName(p.person);
  switch (p.waitsOn) {
    case 'person': return p.status === 'proposed' ? `${who}: aprobar o ajustar` : p.status === 'interviewing' ? `${who}: responder las preguntas` : p.status === 'confirming' ? `${who}: confirmar el resumen` : `${who}: responder`;
    case 'ronin': return p.running ? 'ronin trabajando' : p.status === 'approved' && p.issue ? `ronin: el cambio en #${p.issue}` : p.status === 'fixing' && p.issue ? `ronin: el arreglo en #${p.issue}` : p.status === 'minor' ? 'ronin: el prototipo' : p.status === 'reproducing' ? 'ronin: reproducirlo' : p.status === 'thinking' ? 'ronin: leerlo' : 'ronin: abrir el issue';
    case 'team': return p.pr ? `Un dev: aprobar el PR #${p.pr}` : `El equipo: #${p.issue}`;
    default: return PED_CLOSED.includes(p.status) ? 'Cerrado' : 'Nadie';
  }
}

// A run's card, which a meeting's page shares.
function pedRunCard(run) {
  const live = run.state === 'running';
  return `<div class="pd-run">${dot(run.state)}<span class="nm">${esc(typeName(run.taskType))}${run.issueNumber ? ` · #${run.issueNumber}` : run.prNumber ? ` · PR #${run.prNumber}` : ''}</span>
    <span class="st">${live ? '<span data-since="' + esc(run.startedAt) + '"></span>' : [run.durationMs !== undefined ? duration(run.durationMs) : null, run.costUsd !== undefined ? money(run.costUsd) : null, STATE[run.state]?.[2]].filter(Boolean).map(esc).join(' · ')}</span>
    <button class="go" data-prun="${esc(run.runId)}">${live ? 'Ver en vivo' : 'Ver corrida'} →</button>
    ${run.lastStep ? `<span class="last">${live ? '▸' : 'último:'} ${esc(run.lastStep)}</span>` : ''}</div>`;
}

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
}

// `run`: one of its runs to show on its Corridas tab (Hoy's timeline).
function openPedido(n, run = null) {
  S.sel = null;
  S.page = 'pedido';
  S.ped = { n, run };
  stopStream();
  if (location.pathname !== `/pedidos/${n}`) history.pushState(null, '', `/pedidos/${n}`);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
}

// The request's issue and its PR (#158), read as on their page, from
// /api/items/<id>/detail, without leaving the request. Acting on them
// (comments, review, actions) stays on their page. The request's page gives
// the element (PAGE_HOST.requestDoc); this draws in it, again as the
// snapshot and GitHub's copy change.
let pedDoc = null;
const pedGhId = (d) => `${d.repo}#${d.show === 'pr' && d.pr ? d.pr : d.issue}`;

function pedGhHTML(d) {
  const isPr = Boolean(d.show === 'pr' && d.pr);
  const id = pedGhId(d);
  const prId = d.pr ? `${d.repo}#${d.pr}` : null;
  // Not in the sidebar (a team issue nobody took): known by its number, as select() does.
  if (!itemById(id)) S.extra[id] = { id, repo: d.repo, number: isPr ? d.pr : d.issue, kind: isPr ? 'pr' : 'issue', title: `#${isPr ? d.pr : d.issue}`, status: 'open', runs: 0, listed: false };
  const entry = S.detail[id];
  if (!entry?.data && !entry?.loading && !entry?.error) queueMicrotask(() => loadDetail(id));
  // The PR's checks and review, from the sidebar's issue or PR when it's there.
  const pr = [itemById(`${d.repo}#${d.issue}`), prId && itemById(prId)].map((i) => i?.pr).find((p) => p && p.number === d.pr);
  const checks = checksChip(pr?.checks);
  const seg = `<div class="seg"><button data-pgh="issue" aria-pressed="${!isPr}">Issue #${d.issue}</button>${d.pr ? `<button data-pgh="pr" aria-pressed="${isPr}">PR #${d.pr}${checks?.[0] === 'crit' ? dotClass('crit') : ''}</button>` : '<button disabled>Sin PR todavía</button>'}</div>`;
  const dd = entry?.data;
  const doc = dd && (isPr ? dd.pr : dd.issue);
  const buttons = `${isPr && doc?.state === 'OPEN' ? '<button class="act-btn" data-pgfiles>Revisar el PR</button>' : ''}<button class="gh" data-pitem="${esc(id)}">Abrir la ficha</button>${doc ? `<a class="gh" href="${esc(doc.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}`;
  const bar = `<div class="pd-ghbar">${seg}<span class="sp">${buttons}</span></div>`;
  if (!doc) return bar + `<div class="empty">${entry?.error || dd?.error ? `No se pudo leer de GitHub: ${esc(entry?.error ?? dd.error)}` : 'Cargando de GitHub…'}</div>`;
  const item = itemById(id);
  const chips = [];
  if (isPr && checks) chips.push(checks);
  if (isPr && doc.mergeable === 'CONFLICTING') chips.push(['crit', `conflictos con ${doc.baseRefName}`]);
  if (isPr && pr?.reviewDecision === 'APPROVED') chips.push(['ok', 'aprobado']);
  else if (isPr && pr?.reviewDecision === 'CHANGES_REQUESTED') chips.push(['warn', 'cambios pedidos']);
  const facts = [];
  if (!isPr && item?.slices?.length) facts.push(`${item.slices.filter((sl) => sl.status === 'merged').length} de ${item.slices.length} slices mergeadas`);
  if (isPr && doc.headRefName) facts.push(`${doc.headRefName} → ${doc.baseRefName}`);
  const entries = conversation(doc);
  return bar + `<div class="pd-ghhead"><h2>${esc(doc.title)} <span class="n">#${doc.number}</span></h2>
      <div class="state">${ghPill(item, dd)}${chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('')}${doc.labels.map((l) => `<span class="chip plain">${esc(l)}</span>`).join('')}${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>
    <div class="page pd-ghpage"><div class="meta">${avatar(doc.author)}<b>${esc(doc.author)}</b><span>${esc(when(doc.createdAt))}</span></div>
      <div class="md">${doc.body.trim() ? md(doc.body, d.repo) : '<p class="m">Sin descripción.</p>'}</div></div>
    ${entries.length ? `<div class="comments">${entries.map((e) => entryHTML(e, dd, doc, d.repo)).join('')}</div>` : '<p class="m pd-note">Nadie comentó todavía.</p>'}`;
}

function drawPedDoc() {
  if (!pedDoc?.element.isConnected) return;
  const { element, doc, onShow } = pedDoc;
  const html = pedGhHTML(doc);
  if (element._html === html) return;
  element._html = html;
  element.innerHTML = html;
  wireCenter();
  for (const b of element.querySelectorAll('[data-pitem]')) b.onclick = () => select(b.dataset.pitem);
  for (const b of element.querySelectorAll('[data-pgh]')) b.onclick = () => onShow(b.dataset.pgh);
  element.querySelector('[data-pgfiles]')?.addEventListener('click', () => {
    const id = pedGhId(doc);
    S.doc[id] = 'files';
    select(id);
  });
}

// ---------- deploys (#158)
// A deploy is a GitHub release ronin publishes on the tag someone writes;
// the repo's workflow does the rest. Everything on the branch, or — where
// the repo allows it (deploy.selective) — only the PRs picked, cherry-picked
// onto the last release. Admins only. The page itself is in React
// (src/apps/dashboard/src/pages/deploys/).
function openDespliegues() {
  S.sel = null;
  S.page = 'despliegues';
  stopStream();
  if (location.pathname !== '/despliegues') history.pushState(null, '', '/despliegues');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
}

// The sidebar's "en curso", from what the page last read (PAGE_HOST.read).
const depGoing = () => (S.dep.list ?? []).some((r) => (r.releases ?? []).some((x) => x.deploy?.state === 'running'));

// ---------- metrics (#222, #234)
// Admins only. The pages are in React (src/apps/dashboard/src/pages/metrics/):
// this only routes to their tab.

// `tab`: trabajo (#222) or suscripcion (#234), each at its own address.
function openMetricas(tab = S.mt.tab) {
  S.sel = null;
  S.page = 'metricas';
  S.mt.tab = tab === 'suscripcion' ? 'suscripcion' : 'trabajo';
  stopStream();
  const path = S.mt.tab === 'suscripcion' ? '/metricas/suscripcion' : '/metricas';
  if (location.pathname !== path) history.pushState(null, '', path);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
}

// ---------- meetings (#62)
// The team uploads a meeting's notes and ronin proposes the work that comes
// out of it. The pages are in React (src/apps/dashboard/src/pages/meetings/):
// this only routes to them.

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
}

// `run`: one of its runs, to open the page on (a run picked elsewhere).
function openReunion(n, run = null) {
  S.sel = null;
  S.page = 'reunion';
  S.reu = { n, run };
  stopStream();
  if (location.pathname !== `/reuniones/${n}`) history.pushState(null, '', `/reuniones/${n}`);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
}

// ---------- context
function githubCtxHTML(item) {
  const url = githubUrl(item);
  if (!url) return '';
  return `<section><h3>GitHub</h3><dl class="kv"><dt>${item.kind === 'pr' ? 'PR' : 'Issue'}</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener">#${esc(item.number)} ↗</a></dd></dl></section>`;
}

// Without the synced issue, only the reference ronin left on GitHub.
function linearCtxHTML(item) {
  const l = item.linear;
  const ref = S.detail[item.id]?.data?.linear;
  if (!l) return ref ? `<section><h3>${LIN_ICON} Linear</h3><dl class="kv"><dt>Issue</dt><dd>${safeLinear(ref.url) ? `<a href="${esc(ref.url)}" target="_blank" rel="noopener">${esc(ref.id)} ↗</a>` : esc(ref.id)}</dd></dl></section>` : '';
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
  let html = githubCtxHTML(item) + linearCtxHTML(item);
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
    <dt>Tarea</dt><dd>${esc(runTitle(shown))}${shown.sliceIndex !== undefined ? `, slice ${shown.sliceIndex + 1}` : ''}</dd>
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
// try: the URL is shown as such, not as a link to open yet. While it moves
// to a new commit of the PR it still answers, on the commit it had.
function previewHTML(preview) {
  const left = preview.expiresAt ? Date.parse(preview.expiresAt) - Date.now() : null;
  const safe = /^https?:\/\//.test(preview.url);
  const host = esc(preview.url.replace(/^https?:\/\//, ''));
  const sha = preview.sha ? `<span class="mono">${esc(preview.sha.slice(0, 7))}</span>` : '';
  return `<section><h3>Preview</h3><div class="pv">${esc(preview.appName)} con #${esc(preview.prNumber)}${sha ? ` en ${sha}` : ''}</div>
    ${preview.updating ? `<div class="pv-prep">${dotClass('live')}<span>Actualizándose con el commit nuevo del PR.</span></div>` : ''}
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
    <dt>Agentes</dt><dd>${(slots.repos ?? []).map((r) => `${esc(repoShort(r.repo))}: ${r.used} de ${r.limit}`).join('<br>') || `${slots.used} de ${slots.limit} lugares ocupados`}</dd>
    <dt>Último tick</dt><dd>${tick.lastTickAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastTickAt)))}, duró ${esc(duration(tick.lastTickDurationMs ?? 0))}` : 'sin datos hoy'}</dd>
    <dt>Último evento</dt><dd>${tick.lastEventAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastEventAt)))}` : 'sin datos hoy'}</dd>
    <dt>Repos</dt><dd>${S.snap.repos.map((repo) => `<span class="repo-tag"><i style="background:${repoColor(repo)}"></i>${esc(repo)}</span>`).join('<br>')}</dd></dl></section>
    <section><h3>Previews arriba</h3>${S.snap.previews.length ? S.snap.previews.map((p) => `<div class="pv-row"><div>${esc(p.appName)} con #${esc(p.prNumber)} <span class="m">${esc(repoShort(p.repo))}${p.updating ? ', actualizando' : p.preparing ? ', preparando datos' : ''}</span></div>${/^https?:\/\//.test(p.url) ? (p.preparing ? `<span class="url off">${esc(p.url.replace(/^https?:\/\//, ''))}</span>` : `<a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ''))}</a>`) : ''}</div>`).join('') : '<p class="note">Ninguna.</p>'}</section>
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

// The runner's machine: CPU and memory in use, hot from 85%.
const HOST_HOT = 0.85;
function hostMeter(host) {
  if (!host) return '';
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const bar = (label, value) => `<span class="meter${value >= HOST_HOT ? ' hot' : ''}">${label}<span class="m"><span class="${value >= HOST_HOT ? 'hot' : ''}" style="width:${Math.min(100, value * 100)}%"></span></span><b>${pct(value)}</b></span>`;
  const title = `Runner: CPU ${pct(host.cpu)} de ${host.cores} núcleos (carga ${host.load.join(' / ')}), memoria ${gb(host.memUsedBytes)} de ${gb(host.memTotalBytes)}`;
  return `<span class="host hide-m" title="${esc(title)}">${bar('cpu', host.cpu)}${bar('ram', host.ram)}</span>`;
}

function renderStatus() {
  const { slots, queue, tick } = S.snap.runner;
  const tickAge = tick.lastTickAt ? Date.now() - Date.parse(tick.lastTickAt) : null;
  const dark = document.documentElement.dataset.theme !== 'light';
  $('#statusbar').innerHTML = S.snap.usage.map(usageMeter).join('') +
    hostMeter(S.snap.runner.host) +
    `<span class="sp hide-m" title="${esc((slots.repos ?? []).map((r) => `${repoShort(r.repo)}: ${r.used} de ${r.limit}`).join(', '))}">agentes ${slots.used}/${slots.limit}</span>` +
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

// ---------- ajustes (#174)
// Its own sidebar (Tu cuenta, and Administración for admins) and one page
// per section, like Linear's settings. The page is in React
// (src/apps/dashboard/src/pages/settings/): this routes to its sections and
// draws the sidebar.
const AJ_SECTIONS = {
  perfil: { name: 'Perfil', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>' },
  notificaciones: { name: 'Notificaciones', icon: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>' },
  general: { name: 'General', icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', admin: true },
  repos: { name: 'Repos', icon: '<path d="M5 4h11l3 3v13H5zM9 9h6M9 13h6"/>', admin: true },
  agentes: { name: 'Agentes', icon: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>', admin: true },
  cuentas: { name: 'Cuentas de Claude', icon: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>', admin: true },
  exploracion: { name: 'Exploración', icon: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M14 8l-2 4-4 2 2-4z"/>', admin: true },
  previews: { name: 'Previews', icon: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', admin: true },
  conexiones: { name: 'Conexiones', icon: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>', admin: true },
  usuarios: { name: 'Usuarios', icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3.2 2.6 3.7 5.5"/>', admin: true },
  registro: { name: 'Registro', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>', admin: true },
};
const ajAllowed = (sec) => AJ_SECTIONS[sec] && (!AJ_SECTIONS[sec].admin || S.snap?.access.admin);

// `login`: one of the team; `cuenta`: one of the portal's accounts (#174,
// stage 3); `f`: the list's filter (todos, equipo, portal).
let ajVisits = 0;
function openAjustes(sec = 'perfil', login = null, f = null, cuenta = null) {
  ajVisits += 1;
  S.sel = null;
  S.page = 'ajustes';
  S.aj.sec = ajAllowed(sec) ? sec : 'perfil';
  S.aj.login = S.aj.sec === 'usuarios' && !cuenta ? login : null;
  // For Repos, `login` is the repo (owner/name).
  S.aj.repo = S.aj.sec === 'repos' ? login : null;
  S.aj.cuenta = S.aj.sec === 'usuarios' ? cuenta : null;
  // Asked for once (Pedidos del portal → Usuarios); the page keeps the last one chosen.
  S.aj.f = f;
  stopStream();
  const path = `/ajustes/${S.aj.sec}${S.aj.cuenta ? `/cuenta/${encodeURIComponent(S.aj.cuenta)}` : S.aj.login ? `/${encodeURIComponent(S.aj.login)}` : S.aj.repo ? `/${S.aj.repo}` : ''}`;
  if (location.pathname !== path) history.pushState(null, '', path);
  renderAll();
  if (isMobile() && sec) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
}

function ajNavHTML() {
  const button = (sec) => `<button data-aj="${sec}" aria-pressed="${S.aj.sec === sec && !(sec === 'repos' && S.aj.repo)}"><svg viewBox="0 0 24 24">${AJ_SECTIONS[sec].icon}</svg>${AJ_SECTIONS[sec].name}</button>`;
  return `<button data-aj-back><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>Volver al tablero</button>
    <div class="aj-grp">Tu cuenta <span>${esc(S.snap.me)}</span></div>${button('perfil')}${button('notificaciones')}
    ${S.snap.access.admin ? `<div class="aj-grp">Administración</div>${button('general')}${button('usuarios')}${button('repos')}${S.snap.repos.map((repo) => `<button class="aj-sub" data-aj="repos" data-ajrepo="${esc(repo)}" aria-pressed="${S.aj.sec === 'repos' && S.aj.repo === repo}"><i style="background:${repoColor(repo)}"></i>${esc(repoShort(repo))}</button>`).join('')}${button('agentes')}${button('cuentas')}${button('exploracion')}${button('previews')}${button('conexiones')}${button('registro')}` : ''}`;
}

function wireAjNav() {
  $('#quick').querySelector('[data-aj-back]').onclick = goHome;
  for (const b of $('#quick').querySelectorAll('[data-aj]')) b.onclick = () => openAjustes(b.dataset.aj, b.dataset.ajrepo ?? null);
}

function renderAll() {
  $('#shell').classList.toggle('aj', S.page === 'ajustes');
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
    if (error instanceof Unauthorized) showLogin(error);
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
    if (error instanceof Unauthorized && showLogin(error)) return;
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
    if (error instanceof Unauthorized && showLogin(error)) return;
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  if (S.sel === id) renderCenter();
  drawPedDoc();
  if (S.sel === id) renderCtx();
}

async function select(id) {
  // A meeting's run opens the meeting's page, on that run (#62).
  const reu = /:meeting-read:reunión R-(\d+)/.exec(id);
  if (reu) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openReunion(Number(reu[1]), runId);
    return;
  }
  // A portal request's run (Hoy's timeline) opens the request's page, on that run (#132).
  const ped = /:portal-(?:request|prototype):pedido P-(\d+)/.exec(id);
  if (ped) {
    const runId = S.pendingRun;
    S.pendingRun = null;
    openPedido(Number(ped[1]), runId);
    return;
  }
  const n = /^(.+)#(\d+)$/.exec(id);
  if (!itemById(id) && n) S.extra[id] = { id, repo: n[1], number: Number(n[2]), kind: 'issue', title: `#${n[2]}`, status: 'open', runs: 0, listed: false };
  // An exploration PR is its app's page (#155).
  const xr = xplOfItem(id);
  if (xr) Object.assign(S.xpl, { repo: xr.repo, app: xr.app });
  S.sel = id;
  S.page = xr ? 'exploracion' : null;
  S.runIdx[id] = 0;
  delete S.view[id];
  S.menu = false;
  if (!S.open.includes(id)) S.open.push(id);
  const path = itemPath(id);
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
    S.snap = await api('/api/snapshot');
  } catch (error) {
    if (error instanceof Unauthorized) showLogin(error);
    return;
  }
  showSentReviews();
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
  if (pedDoc?.element.isConnected && Date.now() - (S.detail[pedGhId(pedDoc.doc)]?.at ?? 0) > DETAIL_EVERY_MS) loadDetail(pedGhId(pedDoc.doc));
  // The apps' findings, more often while their page is open: the sidebar counts them too.
  if (xplRows().length && Date.now() - S.xpl.listAt > (['exploraciones', 'exploracion'].includes(S.page) ? PEDIDO_EVERY_MS : XPL_EVERY_MS)) loadExploraciones();
  // An agent's transcript open on an app's runs, while it goes on.
  if (S.page === 'exploracion' && S.xpl.run?.summary?.state === 'running') loadXplRun(S.xpl.run.runId);
  // An app's page with no PR goes on to it once ronin opens one.
  const xr = S.page === 'exploracion' && !S.sel && xplRow0(S.xpl.repo, S.xpl.app);
  if (xr?.pr) select(xr.pr.id);
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
    if (error instanceof Unauthorized) showLogin(error);
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
// /reuniones and /reuniones/<n> (#62), /exploraciones and
// /exploraciones/<owner>/<repo>/<app> (#155), /despliegues (#158, admins
// only): false for any other path.
function openPortalPath() {
  const n = /^\/pedidos\/(\d+)$/.exec(location.pathname)?.[1];
  const r = /^\/reuniones\/(\d+)$/.exec(location.pathname)?.[1];
  const x = /^\/exploraciones\/([\w.-]+\/[\w.-]+)\/([^/]+)$/.exec(location.pathname);
  const aj = /^\/ajustes(?:\/(\w+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/.exec(location.pathname);
  if (aj && aj[1] === 'usuarios' && aj[2] === 'cuenta' && aj[3]) openAjustes('usuarios', null, null, aj[3]);
  else if (aj && aj[1] === 'repos' && aj[3]) openAjustes('repos', `${aj[2]}/${aj[3]}`);
  else if (aj) openAjustes(aj[1] ?? 'perfil', aj[2] ?? null);
  else if (x) openExploracion(x[1], decodeURIComponent(x[2]), new URLSearchParams(location.search).get('f'));
  else if (location.pathname === '/exploraciones') openExploraciones();
  else if (location.pathname === '/despliegues' && S.snap.despliegues) openDespliegues();
  else if (/^\/metricas(\/suscripcion)?$/.test(location.pathname) && S.snap.access?.admin) openMetricas(location.pathname === '/metricas' ? 'trabajo' : 'suscripcion');
  else if (r) openReunion(Number(r));
  else if (location.pathname === '/reuniones') openReuniones();
  else if (n) openPedido(Number(n));
  else if (location.pathname === '/pedidos') openPedidos();
  else if (location.pathname === '/portal' && S.snap.portalAdmin) openAjustes('usuarios', null, 'portal');
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
    // An avatar that didn't load (Métricas) leaves its circle.
    if (img instanceof HTMLImageElement && img.classList.contains('mt-av')) img.replaceWith(Object.assign(document.createElement('span'), { className: 'mt-av' }));
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
  $('#gear').onclick = () => openAjustes();

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
    if (S.decide && !S.decide.sending && event.target.isConnected && !event.target.closest('.drop')) {
      S.decide = null;
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
    // An open adjustment or closing first: what's typed is for its text.
    if (!S.dialog && !S.fdialog && !S.newIssue && !S.xnow && decideKey(event)) return;
    // On an exploration PR's findings, as long as nothing is being typed:
    // j/k go through them, a marks one as looked at, c and r open the dialog.
    const item = S.sel && itemById(S.sel);
    const reviewing = !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && !event.metaKey && !event.ctrlKey && !event.altKey && item && viewOf(item) === 'ficha' && docOf(item) === 'fichas' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    const typing = event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    // The Actions menu: M opens it, and while it's open its keys come first.
    if (!typing && !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && !S.decide && !S.rpanel && actionsKey(event)) return;
    if (!typing && !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && !S.decide && !S.rpanel && !S.menu && event.key.toLowerCase() === 'm' && $('#act')) {
      event.preventDefault();
      toggleActions();
      return;
    }
    // On a PR's files, j/k go from one file to the next (#111).
    if (!typing && !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && item && viewOf(item) === 'ficha' && docOf(item) === 'files' && ['j', 'k', 'v', ...(decidable(item, S.detail[item.id]?.data) ? [] : ['r'])].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'r') openReviewPanel('files');
      else if (event.key === 'v') toggleViewedCurrent();
      else moveFile(event.key === 'j' ? 1 : -1);
      return;
    }
    // On a PR ronin opened: A, P and X decide (#195); Enter confirms an approval.
    const decidingHere = !typing && !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && !S.rpanel && item && decidable(item, S.detail[item.id]?.data);
    if (decidingHere && event.key === 'Enter' && S.decide?.item === item.id && S.decide.kind === 'approve') {
      event.preventDefault();
      sendDecision();
      return;
    }
    const kind = { a: 'approve', p: 'adjust', x: 'close' }[event.key.toLowerCase()];
    if (decidingHere && kind && !seq.key && !S.decide?.sending) {
      event.preventDefault();
      openDecide(kind);
      return;
    }
    if (reviewing && ['j', 'k', 'a', 'c', 'r'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'j' || event.key === 'k') moveFicha(event.key === 'j' ? 1 : -1);
      else if (event.key === 'a') toggleLista();
      else if (document.querySelector(`[data-fact="${event.key === 'c' ? 'cambios' : 'rechazar'}"]`)) openFichaAction(event.key === 'c' ? 'cambios' : 'rechazar');
      return;
    }
    if (event.key === '?' && !typing && !S.dialog && !S.newIssue) {
      event.preventDefault();
      toggleKeysHelp();
      return;
    }
    if (!typing && !S.dialog && !S.fdialog && !S.newIssue && !S.xnow && !S.decide && !S.rpanel && !S.fcomp && navigate(event, item)) return;
    if (event.key !== 'Escape') return;
    if ($('#keys-help')) $('#keys-help').remove();
    else if ($('#lightbox')) return;
    else if (S.newIssue) closeNewIssue();
    else if (S.xnow) closeExploreNow();
    else if (S.decide && !S.decide.sending) {
      S.decide = null;
      renderCenter();
    } else if (S.rpanel && !S.rpanel.sending) {
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
      $('#act')?.focus();
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
