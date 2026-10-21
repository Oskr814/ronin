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

const S = { snap: null, today: null, sel: null, open: [], runIdx: {}, pendingRun: null, filter: null, q: '', itemRuns: {}, run: null, stream: null, detail: {}, view: {}, doc: {}, ficha: {}, fichaOpen: {}, scope: 'all', project: '', extra: {}, newIssue: null, revSent: {}, page: null, ped: { n: null, run: null }, reu: { n: null, run: null }, xpl: { list: null, error: null, listAt: 0, repo: null, app: null, launched: {} }, xnow: null, dep: { list: null }, mt: { tab: 'trabajo' }, aj: { sec: 'perfil', login: null, repo: null, cuenta: null, f: null } };
// The sidebar's Linear filter (#101), remembered per browser.
try { Object.assign(S, JSON.parse(localStorage.getItem('ronin-scope') ?? '{}')); } catch { /* sin storage */ }
function saveScope() {
  try { localStorage.setItem('ronin-scope', JSON.stringify({ scope: S.scope, project: S.project })); } catch { /* sin storage */ }
}
const DETAIL_EVERY_MS = 30_000;

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
function backBar(title) {
  return `<button class="back" id="back"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span>${esc(title)}</span></button>`;
}

// The item's runs: the ones read, or its last one until they are.
const itemRuns = (item) => S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
// The item's page by default; the transcript for what has no page (a changelog entry).
const viewOf = (item) => S.view[item.id] ?? (item.kind === 'other' ? 'tx' : 'ficha');

function renderCenter() {
  itemViews.clear();
  for (const onChange of shellListeners) onChange();
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
    if (S.page === 'exploracion') showPage('exploration', backBar(S.xpl.app), { repo: S.xpl.repo, app: S.xpl.app });
    else showPage('explorations', backBar('Exploraciones'));
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
  // The item's page (pages/item), with the context column under it on a
  // phone. Reviewing findings or a diff takes the room of the context column.
  $('#shell').classList.toggle('wide', viewOf(item) !== 'tx' && ['fichas', 'files'].includes(docOf(item)));
  showPage('item', tabs + backBar(item.title), { id: item.id }, '', `<div class="ctx-inline">${ctxHTML(item)}</div>`);
}

// A page in React (src/apps/dashboard/, #235 stage 7): mounted once where
// it goes, under its head, and unmounted when the center shows anything
// else (setCenter). It reads, polls and redraws on its own.
let reactPage = null;
// The pages that draw from the snapshot (Hoy, an item's) or the
// explorations, told each time the shell draws or those change.
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
  watchItem(key, kind) {
    // Not in the sidebar (a team issue nobody took): known by its number, as select() does.
    const n = Number(key.split('#')[1]);
    if (!itemById(key)) S.extra[key] = { id: key, repo: key.split('#')[0], number: n, kind, title: `#${n}`, status: 'open', runs: 0, listed: false };
    watched.add(key);
    itemViews.clear();
    for (const onChange of shellListeners) onChange();
    const entry = S.detail[key];
    if (!entry?.data && !entry?.loading && !entry?.error) loadDetail(key);
    return () => watched.delete(key);
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
  explorations: () => (xplView ??= { rows: xplRows(), list: S.xpl.list, error: S.xpl.error, launched: { ...S.xpl.launched } }),
  openExplorations: () => openExploraciones(),
  openExploration: (repo, app) => openExploracion(repo, app),
  exploreNow: (repo, app) => openExploreNow(repo, app),
  explored(repo, app) {
    S.xpl.launched[repo] = { app, at: Date.now() };
    closeExploreNow();
    xplChanged();
    refresh().then(loadExploraciones);
  },
  item: (key) => {
    if (!itemViews.has(key)) itemViews.set(key, itemView(key));
    return itemViews.get(key);
  },
  showRun(key, index, view) {
    S.view[key] = view;
    S.runIdx[key] = index;
    loadShownRun();
  },
  showDoc(key, tab) {
    S.doc[key] = tab;
    renderCenter();
  },
  reread(key) {
    if (S.detail[key]) S.detail[key].at = 0;
    loadDetail(key);
    refresh();
  },
  reviewed(key, pr, decision) {
    const item = itemById(key);
    if (!item) return;
    S.revSent[`${item.repo}#${pr}`] = { repo: item.repo, pr, decision, readAt: repoReadAt(item.repo), at: Date.now() };
    showSentReviews();
    renderTree();
    renderCenter();
  },
  movePr,
  keysHelp: () => toggleKeysHelp(),
  shellLayer: () => (S.newIssue || S.xnow ? 'dialog' : null),
  // The finding an exploration PR's Fichas shows (pages/item/Fichas.tsx),
  // kept here for the address (?f=).
  ficha: (key) => ({ ficha: S.ficha[key] ?? null, open: Boolean(S.fichaOpen[key]) }),
  showFicha(key, ficha, open) {
    S.fichaOpen[key] = open;
    if (ficha === null) return;
    S.ficha[key] = ficha;
    const url = `${itemPath(key)}?f=${encodeURIComponent(ficha)}`;
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
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
// `head` and `tail`, what the shell draws around it (the tabs of the open
// items, a phone's context column), drawn again without touching the page.
function showPage(name, head, props = {}, key = '', tail = '') {
  const center = $('#center');
  const id = JSON.stringify([name, props, key]);
  if (reactPage?.key === id && center.contains(reactPage.element)) {
    if (reactPage.head === head && reactPage.tail === tail) return;
    for (const el of [...center.children]) if (el !== reactPage.element) el.remove();
    reactPage.element.insertAdjacentHTML('beforebegin', head);
    reactPage.element.insertAdjacentHTML('afterend', tail);
    Object.assign(reactPage, { head, tail });
    center._html = null;
    tickClocks();
    wireCenter();
    return;
  }
  if (!setCenter(`${head}<div class="react-page" data-page="${esc(name)}"></div>${tail}`)) reactPage?.unmount();
  const element = center.querySelector('.react-page');
  reactPage = { name, key: id, head, tail, element, unmount: window.roninPages.mount(name, element, PAGE_HOST, { ...props }) };
}

// Only touches the page when something changed, so a snapshot that changes
// nothing doesn't reset a selection or a scroll. False when it was the same.
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

// ---------- the item's page (#85)
// In React (src/apps/dashboard/src/pages/item/). The shell keeps what it
// reads of the item, which its context column and the sidebar read too,
// and gives the page a view of it (PAGE_HOST.item), made again each time
// the center is drawn.
const itemViews = new Map();
// The items a request's page shows (PAGE_HOST.watchItem), read again once old.
const watched = new Set();

function itemView(key) {
  const item = itemById(key);
  if (!item) return null;
  const entry = S.detail[key];
  const d = entry?.data;
  return {
    item,
    detail: entry ? { data: d ?? null, error: entry.error ?? null } : null,
    runs: S.itemRuns[key] ?? null,
    run: S.run,
    runIdx: S.runIdx[key] ?? 0,
    view: viewOf(item),
    tabs: d ? docTabsOf(item, d) : [],
    doc: docOf(item),
    decidable: Boolean(d) && decidable(item, d),
    reviewable: Boolean(d) && reviewable(item, d),
    exploration: xplOfItem(key),
  };
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
const sameLogin = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();

// ---------- deciding a PR ronin opened (#195)
// Merge it, ask ronin for an adjustment, or close it: in the item's page
// (pages/item/Decide.tsx). Archivos says which PRs are decided so.
const decidable = (item, d) => reviewable(item, d) && Boolean(d.ronin) && (d.pr.author ?? '').toLowerCase() === d.ronin.toLowerCase() && !d.pr.isDraft;

// ---------- moving around with the keyboard (#195)
// An item's page has its own keys (pages/item); ]p and [p, the next or the
// previous PR that waits on a decision, work from anywhere. The second key
// of a sequence is waited for a moment.
const KEY_SEQ_MS = 900;
const seq = { key: null, timer: 0 };

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

// True when the key was ]p or [p (or its first half).
function nextPrKey(event) {
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
// Finishing the review as in GitHub's "Review changes", in the item's page
// (pages/item/Review.tsx). It drops from the button that opened it: the
// page's head, or the Archivos toolbar.
// A PR's page offers the review, and so does an issue's, for its moving PR
// (the one in its Archivos tab); an exploration PR has its own approval (#93).
const reviewable = (item, d) => (item.kind === 'pr' || item.kind === 'issue') && !d?.exploration && d?.pr?.state === 'OPEN';

// An approval or a request for changes shows on the PR's chips at once,
// until a snapshot brings a read of the repo newer than the one at hand when
// it was sent (the server reads it again right after); a couple of minutes
// at most, if that read never comes.
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
// The list and that page are in React (src/apps/dashboard/src/pages/explorations/),
// and so is the PR's page (pages/item); what stays here is what the sidebar shows.
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

// ---------- Explorar ahora (#155, 3/4)
// Explorar ahora (src/apps/dashboard/src/pages/explorations/ExploreNow.tsx),
// mounted on its own: the app's page and its exploration PR's head open it.
function openExploreNow(repo, app) {
  if (S.xnow) return;
  const layer = Object.assign(document.body.appendChild(document.createElement('div')), { id: 'xlayer' });
  S.xnow = { layer, unmount: window.roninPages.mount('explore-now', layer, PAGE_HOST, { repo, app, onClose: closeExploreNow }) };
}

function closeExploreNow() {
  if (!S.xnow) return;
  const { layer, unmount } = S.xnow;
  S.xnow = null;
  unmount();
  layer.remove();
}

// The apps as the pages see them (PAGE_HOST.explorations), made again when
// the snapshot or the list change, and who to tell.
let xplView = null;
function xplChanged() {
  xplView = null;
  for (const onChange of shellListeners) onChange();
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
  xplChanged();
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
// to them, keeps what the sidebar shows of a request, and reads a request's
// issue and PR while its page shows them (PAGE_HOST.watchItem).
const PED_CLOSED = ['done', 'resolved', 'declined', 'cancelled'];
const firstName = (name) => String(name ?? '').split(' ')[0];

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
  } catch (error) {
    if (error instanceof Unauthorized && showLogin(error)) return;
    entry.error = error.message;
  } finally {
    entry.loading = false;
    entry.at = Date.now();
  }
  if (S.sel === id || watched.has(id)) renderCenter();
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
  xplChanged();
  renderQuick();
  renderTree();
  renderCtx();
  renderStatus();
  await followNewRun();
  renderCenter();
  const detail = S.sel && S.detail[S.sel];
  if (detail && Date.now() - (detail.at ?? 0) > DETAIL_EVERY_MS) loadDetail(S.sel);
  for (const key of watched) if (Date.now() - (S.detail[key]?.at ?? 0) > DETAIL_EVERY_MS) loadDetail(key);
  // The apps' findings, more often while their page is open: the sidebar counts them too.
  if (xplRows().length && Date.now() - S.xpl.listAt > (['exploraciones', 'exploracion'].includes(S.page) ? PEDIDO_EVERY_MS : XPL_EVERY_MS)) loadExploraciones();
  // An app's page with no PR goes on to it once ronin opens one.
  const xr = S.page === 'exploracion' && !S.sel && xplRow0(S.xpl.repo, S.xpl.app);
  if (xr?.pr) select(xr.pr.id);
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

  // An item's page closes what it opens on a click outside, and has its
  // own keys before these (pages/item): what it takes doesn't get here.
  document.addEventListener('keydown', (event) => {
    const typing = event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (event.key === '?' && !typing && !S.newIssue) {
      event.preventDefault();
      toggleKeysHelp();
      return;
    }
    if (!typing && !S.newIssue && !S.xnow && nextPrKey(event)) return;
    if (event.key !== 'Escape') return;
    if ($('#keys-help')) $('#keys-help').remove();
    else if (S.newIssue) closeNewIssue();
    else if (S.xnow) return; // Explorar ahora closes itself, unless it's sending.
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
