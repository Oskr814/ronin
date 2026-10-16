// The dashboard (#65): a page with no data of its own — everything comes from
// the API (/api/*), behind the GitHub login. Plain JS, no build: the two
// libraries it needs are copied into vendor/ (the CSP only runs our own scripts).

import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.esm.js';

const MIN = 60e3;
const SNAPSHOT_EVERY_MS = 5000;

const TYPE = {
  'plan': 'Planificar', 'implement-slice': 'Implementar slice', 'fix-issue': 'Corregir slice', 'fix-review': 'Responder review',
  'fix-e2e': 'Arreglar e2e', 'review-request': 'Pedido en review', 'fix-comments': 'Aplicar comentarios',
  'fix-comments-external': 'Aplicar comentarios', 'resolve-conflicts': 'Resolver conflictos', 'thread-reply-external': 'Responder hilo',
  'external-review': 'Review externa', 'spike': 'Spike', 'write-spec': 'Escribir spec', 'issue-request': 'Pedido en issue',
  'prototype': 'Prototipo', 'update-changelog': 'Changelog', 'explore-inventory': 'Inventario de exploración',
  'explore-function': 'Explorar', 'explore-evaluate': 'Evaluar exploración', 'explore-redo-after': 'Rehacer captura',
  'explore-feedback': 'Comentarios de exploración', 'commit-subject': 'Mensaje de commit', 'prepare-preview-data': 'Datos de preview',
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
};
const SLICE_STATE = { merged: ['ok', 'mergeada'], open: ['warn', 'abierta'], pending: ['pending', 'pendiente'], closed: ['crit', 'PR cerrado sin mergear'] };
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

const S = { snap: null, today: null, sel: null, open: [], runIdx: {}, pendingRun: null, filter: null, q: '', itemRuns: {}, run: null, stream: null, detail: {}, view: {}, doc: {} };
const DETAIL_EVERY_MS = 30_000;

class Unauthorized extends Error {}

async function api(path, init) {
  const response = await fetch(path, { ...init, headers: { Accept: 'application/json' } });
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
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
const itemById = (id) => S.snap?.items.find((item) => item.id === id);

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
    <button data-home aria-pressed="${!S.sel}"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Hoy</button>
    <button data-filter="running" aria-pressed="${S.filter === 'running'}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>Corriendo ahora<span class="c">${running}</span></button>
    <button data-filter="queue" aria-pressed="${S.filter === 'queue'}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>En cola<span class="c">${queued}</span></button>`;
  $('#quick').querySelector('[data-home]').onclick = goHome;
  for (const button of $('#quick').querySelectorAll('[data-filter]')) {
    button.onclick = () => {
      S.filter = S.filter === button.dataset.filter ? null : button.dataset.filter;
      renderQuick();
      renderTree();
    };
  }
}

function itemSub(item) {
  const parts = [itemRef(item)];
  if (item.slices?.length) parts.push(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} ${item.slices.length === 1 ? 'slice' : 'slices'}`);
  else if (item.kind === 'pr' && item.pr?.author && item.pr.author !== 'ronin-agent') parts.push(`de ${item.pr.author}`);
  else if (item.kind !== 'other' && item.lastRun) parts.push(typeName(item.lastRun.taskType));
  return parts.filter(Boolean).join(', ');
}

function itemRow(item) {
  const last = itemLast(item);
  const showSlices = item.slices?.length && (S.sel === item.id || item.status === 'running' || item.status === 'blocked');
  const kids = showSlices ? `<div class="kids">${item.slices.map((slice) => `<button class="kid" data-id="${esc(item.id)}">${dotClass(SLICE_STATE[slice.status][0])}<span class="t">${slice.index + 1}. ${esc(slice.title)}</span><span class="age">${slice.prNumber ? `#${slice.prNumber}` : ''}</span></button>`).join('')}</div>` : '';
  return `<button class="item" data-id="${esc(item.id)}" aria-current="${S.sel === item.id}">
    ${dot(item.status)}<span class="t">${esc(item.title)}</span><span class="age" ${item.status === 'running' && item.lastRun ? `data-since="${esc(item.lastRun.startedAt)}"` : ''}>${esc(itemAge(item))}</span>
    <span class="sub">${esc(itemSub(item))}</span>
    ${last ? `<span class="last">${esc(last)}</span>` : ''}</button>${kids}`;
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
  const q = S.q.toLowerCase();
  const match = (item) => (!q || `${item.title} ${itemRef(item)} ${item.number ?? ''} ${item.lastRun ? typeName(item.lastRun.taskType) : ''}`.toLowerCase().includes(q)) && (S.filter !== 'running' || item.status === 'running');
  let html = '';
  const blocked = S.snap.items.filter((item) => item.status === 'blocked' && match(item));
  if (blocked.length) html += `<div class="grp"><span>Necesitan a alguien</span><span class="n alert">${blocked.length}</span></div>` + blocked.map(itemRow).join('');
  for (const repo of S.snap.repos) {
    const items = S.snap.items.filter((item) => item.repo === repo && item.status !== 'blocked' && match(item));
    html += `<div class="grp"><span class="sq" style="background:${repoColor(repo)}"></span><b>${esc(repoShort(repo))}</b><span class="n">${items.length}</span></div>`;
    html += items.length ? items.map(itemRow).join('') : `<div class="grp-empty">${q || S.filter ? 'Nada coincide.' : 'Nada en curso ni corridas en los últimos 3 días.'}</div>`;
  }
  tree.innerHTML = html;
  for (const button of tree.querySelectorAll('[data-id]')) button.onclick = () => select(button.dataset.id);
}

// ---------- markdown from GitHub
// Whatever comes from GitHub (a PR from anyone, a comment) is untrusted: it's
// parsed by marked and then cleaned by DOMPurify before it reaches the page.
// Images become links (the CSP wouldn't load them anyway), links open
// outside, and a #123 opens that item here when the sidebar has it.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
});
const mdCache = new Map();

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
    link.textContent = `[imagen${img.alt ? `: ${img.alt}` : ''}]`;
    img.replaceWith(link);
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
  if (!setCenter(tabs + backBar(item.title) + headHTML(item) + activityHTML(item) + docHTML(item) + `<div class="ctx-inline">${ctxHTML(item)}</div>`)) return;
  const fresh = $('#doc');
  if (fresh && !isMobile()) fresh.scrollTop = keep;
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
  const pills = `<div class="runs">${back}<span class="lbl">Corridas</span>${runs.map((run, i) => `<button class="pill" data-run="${i}" aria-pressed="${i === index}">${dot(run.state)}${esc(typeName(run.taskType))}<span class="m">${run.state === 'running' ? 'en curso' : `${hhmm(run.startedAt)}${run.durationMs !== undefined ? `, ${duration(run.durationMs)}` : ''}`}</span></button>`).join('')}</div>`;

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
    <div class="row"><h1>${esc(item.title)}${item.number !== undefined ? ` <span class="n">${esc(itemRef(item))}</span>` : ''}</h1>${url ? `<a class="gh" href="${esc(url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}</div>
    <div class="state">${chips.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join('')}${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>`;
}

function activityHTML(item) {
  const runs = itemRuns(item);
  const loading = !(item.id in S.itemRuns);
  if (runs.length === 0) return `<div class="activity"><div class="act-line"><span class="lbl">Actividad</span><span class="m">${loading ? 'Cargando…' : 'Sin corridas de agentes en los últimos 14 días.'}</span></div></div>`;
  const latest = runs[0];
  // The latest run is the line itself (or the card below it); the older ones, pills that open their transcript.
  const older = runs.slice(1).map((run, i) => `<button class="pill" data-runview="${i + 1}">${dot(run.state)}${esc(typeName(run.taskType))}<span class="m">${esc(short(Date.now() - Date.parse(run.endedAt ?? run.startedAt)))}</span></button>`).join('');
  let summary = '';
  if (latest.state !== 'running') {
    const [, , label] = STATE[latest.state] ?? STATE.error;
    const facts = [label, `hace ${short(Date.now() - Date.parse(latest.endedAt ?? latest.startedAt))}`, latest.durationMs !== undefined ? duration(latest.durationMs) : null, latest.costUsd !== undefined ? money(latest.costUsd) : null].filter(Boolean).join(' · ');
    summary = `<span class="latest">${dot(latest.state)}<b>${esc(typeName(latest.taskType))}</b><span class="m">${esc(facts)}</span></span>`;
  }
  const line = `<div class="act-line"><span class="lbl">Actividad</span>${summary}${older ? `<span class="pills">${older}</span>` : ''}<span class="sp"><button class="link" data-runview="0">transcript →</button></span></div>`;
  if (latest.state !== 'running') return `<div class="activity">${line}${latest.state === 'error' && latest.error ? `<div class="last-err">${esc(latest.error)}</div>` : ''}</div>`;
  // The run going on: what the agent last said and its last few steps.
  const lines = S.run?.runId === latest.runId ? S.run.lines : [];
  const said = [...lines].reverse().find((l) => l.type === 'text');
  const steps = lines.filter((l) => l.type === 'tool').slice(-4);
  return `<div class="activity">${line}<div class="livecard"><div class="top">${dot('running')}<b>${esc(typeName(latest.taskType))}${latest.sliceIndex !== undefined ? `, slice ${latest.sliceIndex + 1}` : ''}</b><span class="clk" data-since="${esc(latest.startedAt)}"></span>${latest.model ? `<span class="m">${esc(latest.model)}</span>` : ''}</div>
    ${said ? `<div class="say">${esc(said.text)}</div>` : ''}
    ${steps.length ? `<ol>${steps.map((l) => `<li><b>${esc(VERB[l.name] ?? l.name)}</b> <span class="arg">${esc(String(l.summary ?? '').replace(/^\$ /, ''))}</span></li>`).join('')}</ol>` : `<div class="m">${S.run?.runId === latest.runId ? 'Arrancando…' : 'Cargando…'}</div>`}</div></div>`;
}

function docTabsOf(item, d) {
  if (item.kind === 'issue') return [['issue', 'Issue'], ...(d?.pr ? [['pr', `PR #${d.pr.number}`]] : []), ['comments', 'Comentarios']];
  return [['pr', 'Descripción'], ...(d?.issue ? [['issue', `Issue #${d.issue.number}`]] : []), ['comments', 'Comentarios']];
}
const docKeyOf = (item) => `${item.id}:${S.doc[item.id] ?? ''}`;

function docHTML(item) {
  if (item.kind === 'other') return '';
  const entry = S.detail[item.id];
  const d = entry?.data;
  if (!d) return `<div class="doc" id="doc"><div class="empty">${entry?.error ? `No se pudo leer de GitHub: ${esc(entry.error)}` : 'Cargando de GitHub…'}</div></div>`;
  const tabs = docTabsOf(item, d);
  const cur = tabs.some(([k]) => k === S.doc[item.id]) ? S.doc[item.id] : tabs[0][0];
  const own = item.kind === 'issue' ? d.issue : d.pr;
  const count = own?.comments.length ?? 0;
  const bar = `<div class="doctabs" role="tablist">${tabs.map(([k, label]) => `<button class="doctab" role="tab" data-doc="${k}" aria-selected="${k === cur}">${esc(label)}${k === 'comments' ? `<span class="c">${count}</span>` : ''}</button>`).join('')}
    <span class="src">${d.error ? `<span class="bad">GitHub no respondió: ${esc(d.error)}</span>, ` : ''}${d.fetchedAt ? `leído hace ${esc(short(Date.now() - Date.parse(d.fetchedAt)))}` : ''}</span></div>`;
  let body;
  if (cur === 'comments') {
    body = count
      ? `<div class="comments">${own.comments.map((c) => `<article class="cm${c.author === d.ronin ? ' bot' : ''}"><header>${avatar(c.author)}<b>${esc(c.author || 'alguien')}</b><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(when(c.createdAt))}</a></header><div class="md">${md(c.body, item.repo)}</div></article>`).join('')}</div>`
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

const avatar = (login) => (/^[\w-]+$/.test(login ?? '') ? `<img class="av" src="https://avatars.githubusercontent.com/${login}?s=40" alt="">` : '<span class="av"></span>');
const when = (iso) => (iso ? new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function wireCenter() {
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => select(button.dataset.tab);
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

function renderToday() {
  const t = S.today;
  const running = S.snap.items.filter((i) => i.status === 'running').length;
  const blocked = S.snap.items.filter((i) => i.status === 'blocked').length;
  const previews = S.snap.previews.length;
  const lead = [
    running ? `${running} ${running === 1 ? 'agente trabajando' : 'agentes trabajando'}` : 'ningún agente trabajando',
    blocked ? `${blocked} ${blocked === 1 ? 'issue espera' : 'issues esperan'} a alguien` : null,
    previews ? `${previews} ${previews === 1 ? 'preview arriba' : 'previews arriba'}` : null,
  ].filter(Boolean).join(', ');
  if (!t) return `<div class="today"><h1>Hoy</h1><p class="lead">${esc(lead[0].toUpperCase() + lead.slice(1))}.</p><div class="empty">Cargando…</div></div>`;
  const d = t.today;
  const okPct = d.finished ? `${Math.round((d.ok / d.finished) * 100)}%` : '—';
  const kpis = `<div class="kpis">
    <div class="kpi"><div class="v">${d.runs}</div><div class="l">corridas hoy</div><div class="d">${t.yesterday.runs} ayer</div></div>
    <div class="kpi"><div class="v">${okPct}</div><div class="l">terminaron bien</div><div class="d">${d.finished ? `${d.ok} de ${d.finished} terminadas` : 'ninguna terminada todavía'}</div></div>
    <div class="kpi"><div class="v">${d.medianMs !== null ? esc(duration(d.medianMs)) : '—'}</div><div class="l">duración mediana</div><div class="d">${d.p90Ms !== null ? `p90: ${esc(duration(d.p90Ms))}` : '&nbsp;'}</div></div>
    <div class="kpi"><div class="v">${d.costUsd ? esc(money(d.costUsd)) : 'US$0'}</div><div class="l">costo hoy</div><div class="d">${[d.failed ? `${d.failed} con error` : null, d.usageLimit ? `${d.usageLimit} sin cuota` : null].filter(Boolean).join(', ') || 'sin errores'}</div></div>
  </div>`;

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
  return `<div class="today"><h1>Hoy</h1><p class="lead">${esc(lead[0].toUpperCase() + lead.slice(1))}.</p>${kpis}${timeline}</div>`;
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
}

function goHome() {
  S.sel = null;
  stopStream();
  if (location.pathname !== '/') history.pushState(null, '', '/');
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  refresh();
}

// ---------- context
function ctxHTML(item) {
  const runs = itemRuns(item);
  let html = '';
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
        return `<div class="sl ${slice.status === 'pending' ? 'pending' : ''}">${dotClass(cls)}<span>${slice.index + 1}. ${esc(slice.title)}</span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">#${esc(slice.prNumber)}</a>` : '<span></span>'}<small>${esc(text)}${detail ? `, ${esc(detail)}` : ''}</small></div>`;
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

function previewHTML(preview) {
  const left = preview.expiresAt ? Date.parse(preview.expiresAt) - Date.now() : null;
  const safe = /^https?:\/\//.test(preview.url);
  return `<section><h3>Preview</h3><div class="pv">${esc(preview.appName)} con #${esc(preview.prNumber)}</div>
    ${safe ? `<a class="url" href="${esc(preview.url)}" target="_blank" rel="noopener">${esc(preview.url.replace(/^https?:\/\//, ''))}</a>` : ''}
    ${left !== null ? `<dl class="kv" style="margin-top:8px"><dt>Se baja en</dt><dd data-until="${esc(preview.expiresAt)}">${esc(clock(left))}</dd></dl><div class="ttl"><span style="width:${Math.max(0, Math.min(100, (left / (60 * MIN)) * 100))}%"></span></div>` : ''}
    <p class="note">Los usuarios de prueba están en el comentario de la preview, en el PR.</p></section>`;
}

function renderCtx() {
  const item = S.sel && itemById(S.sel);
  if (item) {
    $('#ctx').innerHTML = ctxHTML(item);
    return;
  }
  const { tick, slots } = S.snap.runner;
  $('#ctx').innerHTML = `<section><h3>Runner</h3><dl class="kv">
    <dt>Agentes</dt><dd>${slots.used} de ${slots.limit} lugares ocupados</dd>
    <dt>Último tick</dt><dd>${tick.lastTickAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastTickAt)))}, duró ${esc(duration(tick.lastTickDurationMs ?? 0))}` : 'sin datos hoy'}</dd>
    <dt>Último evento</dt><dd>${tick.lastEventAt ? `hace ${esc(short(Date.now() - Date.parse(tick.lastEventAt)))}` : 'sin datos hoy'}</dd>
    <dt>Repos</dt><dd>${S.snap.repos.map((repo) => `<span class="repo-tag"><i style="background:${repoColor(repo)}"></i>${esc(repo)}</span>`).join('<br>')}</dd></dl></section>
    <section><h3>Previews arriba</h3>${S.snap.previews.length ? S.snap.previews.map((p) => `<div class="pv-row"><div>${esc(p.appName)} con #${esc(p.prNumber)} <span class="m">${esc(repoShort(p.repo))}</span></div>${/^https?:\/\//.test(p.url) ? `<a class="url" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ''))}</a>` : ''}</div>`).join('') : '<p class="note">Ninguna.</p>'}</section>
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
  S.sel = id;
  S.runIdx[id] = 0;
  delete S.view[id];
  if (!S.open.includes(id)) S.open.push(id);
  const path = `/i/${encodeURIComponent(id)}`;
  if (location.pathname !== path) history.pushState(null, '', path);
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

function selectedFromPath() {
  const match = /^\/i\/(.+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

async function boot() {
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
  if (fromPath) await select(fromPath);
  else renderAll();

  $('#q').oninput = (event) => {
    S.q = event.target.value;
    renderTree();
  };
  addEventListener('popstate', () => {
    const id = selectedFromPath();
    if (id) select(id);
    else {
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
