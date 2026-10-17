// The request portal (#114): people without GitHub ask ronin for small
// changes. A page with no data of its own — everything comes from
// /api/portal/*, behind the login with email and password. Plain JS, no
// build, like the dashboard.

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const S = { me: null, view: 'login', error: null, info: null, busy: false, token: null, link: null, picked: null, menu: false, requests: [], cur: null, detail: null, pending: [], draft: '', sending: false, zoom: null, deciding: null, cancelling: false };

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  const response = await fetch(path, body === undefined
    ? { headers: { Accept: 'application/json' } }
    : { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const said = await response.json().then((b) => b?.error).catch(() => null);
    throw new ApiError(said ?? 'Algo falló. Prueba de nuevo.', response.status);
  }
  return response.status === 204 ? null : response.json();
}

const SEAL = '<div class="seal seal-lg" aria-hidden="true">浪人</div>';
const msg = () => `${S.error ? `<p class="msg-bad" role="alert">${esc(S.error)}</p>` : ''}${S.info ? `<p class="msg-ok">${esc(S.info)}</p>` : ''}`;

// ---------- login, and the forgotten password
function loginHTML() {
  if (S.view === 'forgot') {
    return `<div class="gate"><form class="card" id="f">
      <div class="head">${SEAL}<h1>¿Olvidaste tu contraseña?</h1><p>Escribe tu correo y te mandamos un enlace para crear una nueva.</p></div>
      <div class="field"><label for="em">Correo</label><input id="em" type="email" autocomplete="username" required></div>
      ${msg()}
      <button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Enviando…' : 'Mandarme el enlace'}</button>
      <div class="foot"><button type="button" class="linkish" data-go="login">Volver a entrar</button></div>
    </form></div>`;
  }
  return `<div class="gate"><form class="card" id="f">
    <div class="head">${SEAL}<h1>Pedidos de ajustes</h1><p>Pide cambios pequeños en tus aplicaciones. Al entrar eliges en cuál.</p></div>
    <div class="field"><label for="em">Correo</label><input id="em" type="email" autocomplete="username" required></div>
    <div class="field"><label for="pw">Contraseña</label><input id="pw" type="password" autocomplete="current-password" required></div>
    ${msg()}
    <button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Entrando…' : 'Entrar'}</button>
    <div class="foot"><button type="button" class="linkish" data-go="forgot">¿Olvidaste tu contraseña?</button><span>¿No tienes cuenta? Pídesela al equipo de desarrollo.</span></div>
  </form></div>`;
}

async function submitLogin(event) {
  event.preventDefault();
  // Read before the form is drawn again (the busy state), which empties it.
  const email = $('#em').value;
  const password = $('#pw')?.value ?? '';
  const keep = { email };
  S.busy = true; S.error = null; S.info = null;
  render(keep);
  try {
    if (S.view === 'forgot') {
      await api('/api/portal/forgot', { email });
      S.info = 'Si hay una cuenta con ese correo, te llegará un enlace en unos minutos. Revisa también el correo no deseado.';
    } else {
      S.me = await api('/api/portal/login', { email, password });
      S.busy = false;
      await enter();
      return;
    }
  } catch (error) {
    S.error = error.message;
  }
  S.busy = false;
  render(keep);
}

// ---------- setting the password from an emailed link
function passwordHTML() {
  if (!S.link) {
    return `<div class="gate"><div class="card"><div class="head">${SEAL}<h1>Enlace no válido</h1></div>${msg()}
      <div class="foot"><a class="linkish" href="/">Ir a entrar</a></div></div></div>`;
  }
  const invite = S.link.kind === 'invite';
  return `<div class="gate"><form class="card" id="f">
    <div class="head">${SEAL}<h1>${invite ? 'Crea tu contraseña' : 'Cambia tu contraseña'}</h1><p>${esc(S.link.name)} · ${esc(S.link.email)}</p></div>
    <div class="field"><label for="pw">Contraseña nueva</label><input id="pw" type="password" autocomplete="new-password" minlength="10" required><small>Al menos 10 caracteres.</small></div>
    <div class="field"><label for="pw2">Repítela</label><input id="pw2" type="password" autocomplete="new-password" minlength="10" required></div>
    ${msg()}
    <button class="btn primary" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Guardando…' : invite ? 'Crear contraseña y entrar' : 'Cambiar contraseña y entrar'}</button>
  </form></div>`;
}

async function submitPassword(event) {
  event.preventDefault();
  const password = $('#pw').value;
  if (password !== $('#pw2').value) {
    S.error = 'Las dos contraseñas no coinciden.';
    render();
    return;
  }
  S.busy = true; S.error = null;
  render();
  try {
    S.me = await api('/api/portal/password', { token: S.token, password });
    S.token = null;
    S.busy = false;
    history.replaceState(null, '', '/');
    await enter();
    return;
  } catch (error) {
    S.error = error.message;
  }
  S.busy = false;
  render();
}

// ---------- once in
const key = (a) => `${a.repo}:${a.app}`;
const STATUS = {
  thinking: ['run', 'ronin lo está revisando'],
  asking: ['warn', 'Espera tu respuesta'],
  answered: ['idle', 'Respondido'],
  minor: ['run', 'Preparando prototipo'],
  proposed: ['warn', 'Prototipo listo'],
  approved: ['run', 'En desarrollo'],
  done: ['ok', 'Listo'],
  resolved: ['ok', 'Resuelto'],
  declined: ['idle', 'Cerrado'],
  cancelled: ['idle', 'Cancelado'],
  big: ['idle', 'Con el equipo'],
};
const CLOSED = {
  thinking: 'ronin está revisando tu pedido. Puedes cerrar la página: te avisamos por correo.',
  minor: 'ronin está armando el prototipo. Puedes cerrar la página: te avisamos por correo cuando esté listo.',
  approved: 'Aprobaste el prototipo. ronin hace el cambio y una persona del equipo lo revisa; te avisamos por correo cuando esté listo.',
  done: 'Listo: el cambio sale en la próxima actualización de la aplicación.',
  resolved: 'El equipo de desarrollo resolvió este pedido.',
  declined: 'El equipo de desarrollo decidió no hacer este pedido por ahora. Puedes enviar uno nuevo cuando quieras.',
  cancelled: 'Cancelaste este pedido.',
  big: 'El equipo de desarrollo tiene este pedido. Te avisamos por correo cuando esté resuelto.',
};
const WORKING = {
  thinking: ['ronin está revisando tu pedido…', 'Lee lo que escribiste y revisa la aplicación. Suele tardar unos minutos.'],
  minor: ['ronin está armando el prototipo…', 'Abre la aplicación, hace el cambio de prueba y toma capturas de antes y después. Suele tardar entre 5 y 15 minutos.'],
};
const POLL_MS = 4000;
const hhmm = (iso) => new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const paragraphs = (text) => esc(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const chip = (status) => {
  const [cls, label] = STATUS[status] ?? ['idle', status];
  return `<span class="chip ${cls}">${label}</span>`;
};

function sideHTML() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const list = S.requests.length
    ? S.requests.map((r) => `<button class="req" data-req="${r.number}" aria-current="${S.cur === r.number}"><span class="t">${esc(r.title)}</span><span class="pj">${esc(r.appName)}</span><span class="m">${chip(r.status)}<span class="p">P-${r.number}</span></span></button>`).join('')
    : '<div class="none">Todavía no tienes pedidos.</div>';
  return `<aside class="side">
    <div class="brand"><div class="seal" aria-hidden="true">浪人</div><b>Pedidos</b></div>
    <button class="btn primary new" data-new>+ Nuevo pedido</button>
    <h3>Mis pedidos</h3>
    <div class="reqs">${list}</div>
    <div class="me"><div class="av" aria-hidden="true">${esc(initials(S.me.name))}</div><div class="who">${esc(S.me.name)}<small>${esc(S.me.email)}</small></div>
      <div class="acts"><button class="btn" data-theme-t title="${dark ? 'Tema claro' : 'Tema oscuro'}" aria-label="${dark ? 'Tema claro' : 'Tema oscuro'}">${dark ? '☀' : '☾'}</button><button class="btn" data-logout>Salir</button></div></div>
  </aside>`;
}

const MENU = '<button class="menu-btn" data-menu aria-label="Mis pedidos"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>';

function composerHTML(placeholder, label, note = '', above = '') {
  return `<div class="composer"><div class="composer-in">${above}
    <div class="box" id="box">
      ${S.pending.length ? `<div class="pend">${S.pending.map((src, i) => `<div><img src="${src}" alt="Imagen adjunta ${i + 1}"><button data-unpend="${i}" aria-label="Quitar imagen">×</button></div>`).join('')}</div>` : ''}
      <textarea id="ta" rows="2" maxlength="4000" placeholder="${esc(placeholder)}" ${S.sending ? 'disabled' : ''}></textarea>
      <div class="box-f"><label class="icon-btn" title="Adjuntar imágenes"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden id="file"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg><span class="sr">Adjuntar imágenes</span></label>
        <span class="hint">${note || 'Puedes pegar o arrastrar capturas (hasta 4)'}</span><button class="btn primary" data-send ${S.sending ? 'disabled' : ''}>${S.sending ? 'Enviando…' : label}</button></div>
    </div>
    ${S.error ? `<p class="msg-bad" role="alert">${esc(S.error)}</p>` : ''}
  </div></div>`;
}

function newHTML() {
  const apps = S.me.apps;
  if (S.picked && !apps.some((a) => key(a) === S.picked)) S.picked = null;
  if (!S.picked && apps.length) S.picked = key(apps[0]);
  const left = Math.max(0, S.me.today.limit - S.me.today.used);
  const body = apps.length ? `<h3>¿En qué aplicación es el cambio?</h3>
    <p>Solo ves las que el equipo te habilitó.</p>
    <div class="projects">${apps.map((a) => `<button class="proj" data-app="${esc(key(a))}" aria-pressed="${key(a) === S.picked}"><span class="org">${esc(a.org)}</span><b>${esc(a.name)}</b>${a.description ? `<span>${esc(a.description)}</span>` : ''}</button>`).join('')}</div>
    <div class="note"><b>Qué se puede pedir aquí:</b> ajustes chicos sobre lo que ya existe: un texto, un enlace, un dato que falta en una pantalla, algo que se ve mal en el teléfono.
      Lo que sea un proyecto o una función nueva lo recibe el equipo de desarrollo, y te avisamos cuando esté resuelto.</div>
    <ul class="tips"><li>Cuenta qué quieres cambiar y en qué pantalla.</li><li>Pega o arrastra capturas: ayudan mucho.</li><li>ronin te puede hacer preguntas antes de proponer el cambio.</li></ul>`
    : '<h3>Todavía no tienes aplicaciones habilitadas</h3><p>Pídele al equipo de desarrollo que te habilite las aplicaciones en las que necesitas pedir ajustes.</p>';
  const composer = !apps.length ? ''
    : left === 0 ? `<div class="closed-bar">Llegaste al tope de ${S.me.today.limit} pedidos por hoy. Mañana puedes enviar más.</div>`
      : composerHTML('Describe el cambio que necesitas…', 'Enviar pedido', `Te ${left === 1 ? 'queda 1 pedido' : `quedan ${left} pedidos`} por hoy · puedes pegar o arrastrar capturas`);
  return `<div class="top">${MENU}<h2>Nuevo pedido</h2></div>
    <div class="content"><div class="content-in">${body}</div></div>${composer}`;
}

function threadHTML(d) {
  const out = [`<div class="sys">${esc(d.appName)} · ${esc(hhmm(d.createdAt))}</div>`];
  for (const m of d.messages) {
    const who = m.from === 'ronin' ? '<div class="seal" aria-hidden="true">浪人</div>' : `<div class="av" aria-hidden="true">${esc(initials(S.me.name))}</div>`;
    // A prototype's images come with their captions ("Antes: …", "Después: …").
    const images = !m.images.length ? ''
      : m.captions ? `<div class="shots">${m.images.map((src, i) => `<figure class="shot"><button class="att" data-zoom="${esc(src)}"><img src="${esc(src)}" alt="${esc(m.captions[i] ?? `Imagen ${i + 1}`)}"></button><figcaption>${esc(m.captions[i] ?? '')}</figcaption></figure>`).join('')}</div>`
        : `<div class="atts">${m.images.map((src, i) => `<button class="att" data-zoom="${esc(src)}"><img src="${esc(src)}" alt="Imagen ${i + 1}" loading="lazy"></button>`).join('')}</div>`;
    out.push(`<div class="msg ${m.from === 'ronin' ? '' : 'mine'}">${who}<div class="body"><div class="who"><b>${m.from === 'ronin' ? 'ronin' : esc(S.me.name)}</b> ${esc(hhmm(m.at))}</div>
      <div class="bubble">${m.text ? paragraphs(m.text) : ''}${images}</div></div></div>`);
  }
  const working = WORKING[d.status];
  if (working) out.push(`<div class="working"><div class="spin" aria-hidden="true"></div><div>${working[0]}<small>${working[1]}</small></div></div>`);
  return out.join('');
}

function requestHTML() {
  const d = S.detail;
  if (!d) return `<div class="top">${MENU}<h2>Cargando…</h2></div><div class="content"></div>`;
  const open = d.status === 'asking' || d.status === 'answered';
  const foot = S.cancelling ? cancelHTML(d) : d.status === 'proposed' ? decisionHTML(d)
    : open ? composerHTML(d.status === 'asking' ? 'Responde a ronin…' : 'Escríbele a ronin si necesitas algo más…', 'Enviar')
      : `<div class="closed-bar">${CLOSED[d.status] ?? ''}</div>`;
  return `<div class="top">${MENU}<h2>${esc(d.title)}</h2><span class="proj-l">${esc(d.appName)} · P-${d.number}</span>${chip(d.status)}${d.cancellable && !S.cancelling ? '<button class="btn cancel-btn" data-cancel>Cancelar<span class="wide"> pedido</span></button>' : ''}</div>
    <div class="content" id="thread"><div class="content-in thread">${threadHTML(d)}</div></div>
    ${foot}`;
}

function cancelHTML(d) {
  return `<div class="composer"><div class="composer-in"><div class="confirm">
    <b>¿Cancelar este pedido?</b>
    <p>${d.status === 'big' ? 'El equipo de desarrollo deja de tenerlo pendiente.' : 'ronin deja de trabajar en él.'} No se puede deshacer, pero puedes enviar uno nuevo cuando quieras.</p>
    <div class="confirm-f"><button class="btn" data-uncancel ${S.sending ? 'disabled' : ''}>Volver</button><button class="btn primary" data-cancelled ${S.sending ? 'disabled' : ''}>${S.sending ? 'Cancelando…' : 'Sí, cancelar'}</button></div>
  </div>${S.error ? `<p class="msg-bad" role="alert">${esc(S.error)}</p>` : ''}</div></div>`;
}

async function cancelRequest() {
  if (S.sending) return;
  S.sending = true;
  S.error = null;
  render();
  try {
    S.detail = await api(`/api/portal/requests/${S.cur}/cancel`, {});
    S.cancelling = false;
    await loadList();
  } catch (error) {
    if (error.status === 401) return toLogin();
    S.error = error.message;
  }
  S.sending = false;
  render();
  poll();
}

// Under a prototype: approve it, turn it down (with an optional note), or
// write an adjustment while there are some left.
function decisionHTML(d) {
  if (S.deciding) {
    const approve = S.deciding === 'aprobar';
    return `<div class="composer"><div class="composer-in"><div class="confirm">
      <b>${approve ? '¿Apruebas este prototipo?' : '¿Se lo pasamos al equipo?'}</b>
      <p>${approve ? 'El equipo de desarrollo hará el cambio tal como lo ves.' : 'El equipo de desarrollo verá tu pedido, lo que conversamos y el prototipo.'}</p>
      ${approve ? '' : '<textarea id="note" rows="2" maxlength="4000" placeholder="¿Qué no te convenció? (opcional)"></textarea>'}
      <div class="confirm-f"><button class="btn" data-undecide ${S.sending ? 'disabled' : ''}>Volver</button><button class="btn primary" data-decided ${S.sending ? 'disabled' : ''}>${S.sending ? 'Enviando…' : approve ? 'Sí, aprobar' : 'Pasar al equipo'}</button></div>
    </div>${S.error ? `<p class="msg-bad" role="alert">${esc(S.error)}</p>` : ''}</div></div>`;
  }
  const left = d.adjustmentsLeft;
  const bar = `<div class="decide"><span>¿Qué te parece el prototipo?</span><button class="btn" data-decide="rechazar">No me sirve</button><button class="btn primary" data-decide="aprobar">Aprobar</button></div>`;
  if (left === 0) return `<div class="composer"><div class="composer-in">${bar}<p class="hint">No quedan ajustes para este pedido.</p></div></div>`;
  return composerHTML('¿Qué le cambiarías? Escríbelo para otro prototipo…', 'Pedir ajuste', `Te ${left === 1 ? 'queda 1 ajuste' : `quedan ${left} ajustes`} · puedes adjuntar capturas`, bar);
}

function appHTML() {
  return `<div class="app ${S.menu ? 'menu' : ''}">${sideHTML()}<main class="main">${S.cur ? requestHTML() : newHTML()}</main></div>`;
}

// ---------- images: pasted, dropped or picked; big ones are scaled down here
const MAX_SIDE = 2400;
const MAX_RAW = 1.5 * 1024 * 1024;
const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function toDataUrl(file) {
  const url = await readAsDataUrl(file);
  if (file.type === 'image/gif') return url;
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && file.size <= MAX_RAW) return url;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function attach(files) {
  const text = $('#ta')?.value ?? '';
  S.error = null;
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      S.error = 'Solo se aceptan imágenes PNG, JPG, WebP o GIF.';
      continue;
    }
    if (S.pending.length >= 4) {
      S.error = 'Puedes adjuntar hasta 4 imágenes por mensaje.';
      break;
    }
    try {
      S.pending.push(await toDataUrl(file));
    } catch {
      S.error = 'No pude leer una de las imágenes.';
    }
  }
  render();
  if ($('#ta')) $('#ta').value = text;
}

function wireComposer() {
  const box = $('#box');
  if (!box) return;
  const ta = $('#ta');
  $('#file').onchange = (e) => attach([...e.target.files]);
  ta.onpaste = (e) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      attach(files);
    }
  };
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('drag'); };
  box.ondragleave = () => box.classList.remove('drag');
  box.ondrop = (e) => { e.preventDefault(); box.classList.remove('drag'); attach([...e.dataTransfer.files]); };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  ta.value = S.draft;
  ta.oninput = () => { S.draft = ta.value; };
}

async function send() {
  const text = ($('#ta')?.value ?? '').trim();
  if (S.sending || (!text && !S.pending.length)) return;
  S.sending = true;
  S.error = null;
  render();
  try {
    let d;
    if (S.cur) d = await api(`/api/portal/requests/${S.cur}/messages`, { text, images: S.pending });
    else {
      const app = S.me.apps.find((a) => key(a) === S.picked);
      d = await api('/api/portal/requests', { repo: app.repo, app: app.app, text, images: S.pending });
      S.me.today.used += 1;
    }
    S.pending = [];
    S.draft = '';
    S.detail = d;
    S.cur = d.number;
    if (location.pathname !== `/p/${d.number}`) history.pushState(null, '', `/p/${d.number}`);
    await loadList();
  } catch (error) {
    if (error.status === 401) return toLogin();
    S.error = error.message;
  }
  S.sending = false;
  render();
  poll();
}

async function decide() {
  if (S.sending || !S.deciding) return;
  const note = ($('#note')?.value ?? '').trim();
  S.sending = true;
  S.error = null;
  render();
  try {
    S.detail = await api(`/api/portal/requests/${S.cur}/decision`, { decision: S.deciding, text: note });
    S.deciding = null;
    await loadList();
  } catch (error) {
    if (error.status === 401) return toLogin();
    S.error = error.message;
  }
  S.sending = false;
  render();
}

// ---------- data
async function loadList() {
  try {
    S.requests = await api('/api/portal/requests');
  } catch (error) {
    if (error.status === 401) toLogin();
  }
}

async function openRequest(n, push = true) {
  S.cur = n;
  S.detail = null;
  S.menu = false;
  S.error = null;
  S.pending = [];
  S.draft = '';
  S.deciding = null;
  S.cancelling = false;
  if (push && location.pathname !== `/p/${n}`) history.pushState(null, '', `/p/${n}`);
  render();
  try {
    S.detail = await api(`/api/portal/requests/${n}`);
  } catch (error) {
    if (error.status === 401) return toLogin();
    S.cur = null;
    S.error = error.message;
    history.replaceState(null, '', '/');
  }
  render();
  poll();
}

function openNew(push = true) {
  S.cur = null;
  S.detail = null;
  S.menu = false;
  S.error = null;
  if (push && location.pathname !== '/') history.pushState(null, '', '/');
  render();
}

// While ronin reads a request or draws its prototype, its page asks again
// every few seconds.
let pollTimer = null;
function poll() {
  clearTimeout(pollTimer);
  if (!WORKING[S.detail?.status]) return;
  pollTimer = setTimeout(async () => {
    if (document.hidden || !S.cur) return poll();
    const n = S.cur;
    try {
      const d = await api(`/api/portal/requests/${n}`);
      if (S.cur !== n) return;
      const changed = d.status !== S.detail.status || d.messages.length !== S.detail.messages.length;
      S.detail = d;
      if (changed) {
        await loadList();
        render();
      }
    } catch (error) {
      if (error.status === 401) return toLogin();
    }
    poll();
  }, POLL_MS);
}

function toLogin() {
  clearTimeout(pollTimer);
  S.me = null; S.view = 'login'; S.error = null; S.info = null;
  history.replaceState(null, '', '/');
  render();
}

function fromPath(push = false) {
  const match = /^\/p\/(\d+)$/.exec(location.pathname);
  if (match) openRequest(Number(match[1]), push);
  else openNew(push);
}

// ---------- render
// The lightbox lives outside #root: opening it must not re-render the thread and lose its scroll.
function renderZoom() {
  $('#lb')?.remove();
  if (!S.zoom) return;
  document.body.insertAdjacentHTML('beforeend', `<button class="lb" id="lb" data-unzoom aria-label="Cerrar imagen"><img src="${esc(S.zoom)}" alt=""></button>`);
}

function render(keep = {}) {
  const root = $('#root');
  const thread = $('#thread');
  const atBottom = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  if (S.view === 'app') root.innerHTML = appHTML();
  else if (S.view === 'password') root.innerHTML = passwordHTML();
  else root.innerHTML = loginHTML();
  const form = $('#f');
  if (form) form.onsubmit = S.view === 'password' ? submitPassword : submitLogin;
  if (keep.email !== undefined && $('#em')) $('#em').value = keep.email;
  const first = $('#f input');
  if (first && !S.busy && !first.value) first.focus();
  if (S.view === 'app') {
    wireComposer();
    const fresh = $('#thread');
    if (fresh && atBottom) {
      fresh.scrollTop = fresh.scrollHeight;
      // Images grow the thread as they load: stay at the bottom.
      for (const img of fresh.querySelectorAll('img')) if (!img.complete) img.addEventListener('load', () => { fresh.scrollTop = fresh.scrollHeight; }, { once: true });
    }
  }
}

document.addEventListener('click', async (event) => {
  const t = event.target.closest('button');
  if (!t) return;
  if (t.dataset.go) {
    const email = $('#em')?.value;
    S.view = t.dataset.go; S.error = null; S.info = null;
    render({ email });
  } else if (t.dataset.app) {
    S.picked = t.dataset.app;
    render();
  } else if (t.dataset.req) {
    openRequest(Number(t.dataset.req));
  } else if ('new' in t.dataset) {
    openNew();
  } else if ('send' in t.dataset) {
    send();
  } else if (t.dataset.decide) {
    S.deciding = t.dataset.decide;
    S.error = null;
    render();
    $('#note')?.focus();
  } else if ('cancel' in t.dataset) {
    S.cancelling = true;
    S.deciding = null;
    S.error = null;
    render();
  } else if ('uncancel' in t.dataset) {
    S.cancelling = false;
    S.error = null;
    render();
  } else if ('cancelled' in t.dataset) {
    cancelRequest();
  } else if ('undecide' in t.dataset) {
    S.deciding = null;
    S.error = null;
    render();
  } else if ('decided' in t.dataset) {
    decide();
  } else if (t.dataset.unpend !== undefined) {
    S.pending.splice(Number(t.dataset.unpend), 1);
    render();
  } else if (t.dataset.zoom) {
    S.zoom = t.dataset.zoom;
    renderZoom();
  } else if ('unzoom' in t.dataset) {
    S.zoom = null;
    renderZoom();
  } else if ('menu' in t.dataset) {
    S.menu = !S.menu;
    render();
  } else if ('themeT' in t.dataset) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ronin-portal-theme', next); } catch { /* sin storage */ }
    render();
  } else if ('logout' in t.dataset) {
    await api('/api/portal/logout', {}).catch(() => {});
    toLogin();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && S.zoom) {
    S.zoom = null;
    renderZoom();
  }
});

addEventListener('popstate', () => {
  if (S.view === 'app') fromPath();
});

async function enter() {
  S.view = 'app';
  await loadList();
  fromPath();
}

async function start() {
  if (location.pathname === '/contrasena') {
    // The token comes after the #, so it never reaches a server log; it's
    // taken off the address right away.
    S.token = new URLSearchParams(location.hash.slice(1)).get('t');
    history.replaceState(null, '', '/contrasena');
    S.view = 'password';
    try {
      if (!S.token) throw new ApiError('Al enlace le falta una parte. Ábrelo de nuevo desde el correo.', 400);
      S.link = await api('/api/portal/link', { token: S.token });
    } catch (error) {
      S.error = error.message;
    }
    render();
    return;
  }
  try {
    S.me = await api('/api/portal/me');
  } catch {
    S.view = 'login';
    render();
    return;
  }
  await enter();
}

start();
