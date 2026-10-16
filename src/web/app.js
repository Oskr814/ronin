// The dashboard (#65): a page with no data of its own — everything comes from
// the API (/api/*), behind the GitHub login. Plain JS, no build.

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

const S = { snap: null, sel: null, open: [], runIdx: {}, filter: null, q: '', itemRuns: {}, run: null, stream: null };

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
    <button data-filter="running" aria-pressed="${S.filter === 'running'}"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Corriendo ahora<span class="c">${running}</span></button>
    <button data-filter="queue" aria-pressed="${S.filter === 'queue'}"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>En cola<span class="c">${queued}</span></button>`;
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

function renderCenter() {
  const center = $('#center');
  const tabs = `<div class="tabs" role="tablist">${S.open.map((id) => {
    const item = itemById(id);
    const label = item ? item.title : id;
    return `<div class="tab" role="tab" aria-selected="${S.sel === id}"><button class="open" data-tab="${esc(id)}">${item ? dot(item.status) : ''}<span class="l">${esc(label)}</span></button><button class="x" data-close="${esc(id)}" aria-label="Cerrar">×</button></div>`;
  }).join('')}</div>`;

  const item = S.sel && itemById(S.sel);
  if (!item) {
    const running = S.snap.items.filter((i) => i.status === 'running').length;
    center.innerHTML = tabs + `<div class="empty"><b>${running ? `${running} ${running === 1 ? 'agente trabajando' : 'agentes trabajando'}` : 'Ningún agente trabajando ahora'}</b>Elegí algo de la izquierda para ver lo que hizo el agente, paso a paso.</div>`;
    wireCenter();
    return;
  }

  const runs = S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
  if (runs.length === 0) {
    const loading = !(item.id in S.itemRuns);
    center.innerHTML = tabs + backBar(item.title) + `<div class="tx"><div class="empty">${loading ? 'Cargando…' : `<b>Sin corridas de agentes en los últimos 14 días</b>${esc(item.status === 'blocked' ? 'Está bloqueado: el motivo y qué hace falta están en el panel de contexto.' : item.note ? `Ahora: ${item.note}.` : '')}`}</div></div><div class="ctx-inline">${ctxHTML(item)}</div>`;
    wireCenter();
    return;
  }
  const index = Math.min(S.runIdx[item.id] ?? 0, runs.length - 1);
  const pills = `<div class="runs"><span class="lbl">Corridas</span>${runs.map((run, i) => `<button class="pill" data-run="${i}" aria-pressed="${i === index}">${dot(run.state)}${esc(typeName(run.taskType))}<span class="m">${run.state === 'running' ? 'en curso' : `${hhmm(run.startedAt)}${run.durationMs !== undefined ? `, ${duration(run.durationMs)}` : ''}`}</span></button>`).join('')}</div>`;

  const shown = runs[index];
  const loaded = S.run && S.run.runId === shown.runId ? S.run : null;
  let body;
  if (!loaded) {
    body = `<div class="tx"><div class="empty">Cargando la corrida…</div></div>`;
  } else {
    const steps = loaded.lines.map(step).join('');
    body = `<div class="tx" id="tx">${steps || '<div class="empty">El agente todavía no hizo nada.</div>'}${ending(loaded.summary)}</div>
      <div class="foot">${loaded.summary.state === 'running'
        ? `<span class="w">● Trabajando</span><span data-since="${esc(loaded.summary.startedAt)}">${esc(clock(Date.now() - Date.parse(loaded.summary.startedAt)))}</span>`
        : `<span>${esc(STATE[loaded.summary.state]?.[2] ?? loaded.summary.state)}</span>`}<span>${esc(typeName(loaded.summary.taskType))}</span><span class="r">${esc([loaded.summary.model, loaded.summary.worktree].filter(Boolean).join('  '))}</span></div>`;
  }
  const tx = $('#tx');
  const atBottom = tx ? tx.scrollTop + tx.clientHeight >= tx.scrollHeight - 30 : true;
  center.innerHTML = tabs + backBar(item.title) + pills + body + `<div class="ctx-inline">${ctxHTML(item)}</div>`;
  wireCenter();
  const fresh = $('#tx');
  if (fresh && atBottom && !isMobile()) fresh.scrollTop = fresh.scrollHeight;
}

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
  const back = $('#back');
  if (back) back.onclick = () => {
    $('#shell').dataset.m = 'list';
    scrollTo(0, 0);
  };
}

// ---------- context
function ctxHTML(item) {
  const [, chip, label] = STATE[item.status] ?? STATE.error;
  const url = githubUrl(item);
  const runs = S.itemRuns[item.id] ?? (item.lastRun ? [item.lastRun] : []);
  let html = `<section><span class="chip ${chip}">${esc(label)}</span><div class="title">${esc(item.title)}</div>
    <div class="links"><span class="repo-tag"><i style="background:${repoColor(item.repo)}"></i>${esc(repoShort(item.repo))}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(itemRef(item))} en GitHub</a>` : ''}</div>
    ${item.note && item.status !== 'running' ? `<p class="note">${esc(item.note[0].toUpperCase() + item.note.slice(1))}.</p>` : ''}</section>`;
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
  } catch (error) {
    if (error instanceof Unauthorized) return showLogin();
  }
  if (S.sel === id) await loadShownRun();
}

async function select(id) {
  S.sel = id;
  S.runIdx[id] = 0;
  if (!S.open.includes(id)) S.open.push(id);
  const path = `/i/${encodeURIComponent(id)}`;
  if (location.pathname !== path) history.pushState(null, '', path);
  renderAll();
  if (isMobile()) {
    $('#shell').dataset.m = 'detail';
    scrollTo(0, 0);
  }
  await loadItem(id);
}

async function refresh() {
  try {
    S.snap = await api('/api/snapshot');
  } catch (error) {
    if (error instanceof Unauthorized) showLogin();
    return;
  }
  renderQuick();
  renderTree();
  renderCtx();
  renderStatus();
  // The tabs' dots follow the snapshot; the transcript, its own stream.
  if (!S.sel || !S.run) renderCenter();
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
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = clock(Date.now() - Date.parse(el.dataset.since));
    for (const el of document.querySelectorAll('[data-until]')) el.textContent = clock(Date.parse(el.dataset.until) - Date.now());
  }, 1000);
}

boot();
