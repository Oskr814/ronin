// The request portal (#114): people without GitHub ask ronin for small
// changes. A page with no data of its own — everything comes from
// /api/portal/*, behind the login with email and password. Plain JS, no
// build, like the dashboard.

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const S = { me: null, view: 'login', error: null, info: null, busy: false, token: null, link: null, picked: null, menu: false };

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
      S.view = 'app';
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
    S.view = 'app';
    history.replaceState(null, '', '/');
  } catch (error) {
    S.error = error.message;
  }
  S.busy = false;
  render();
}

// ---------- once in
function appHTML() {
  const me = S.me;
  const apps = me.apps;
  if (S.picked && !apps.some((a) => key(a) === S.picked)) S.picked = null;
  if (!S.picked && apps.length) S.picked = key(apps[0]);
  const dark = document.documentElement.dataset.theme !== 'light';
  return `<div class="app ${S.menu ? 'menu' : ''}">
    <aside class="side">
      <div class="brand"><div class="seal" aria-hidden="true">浪人</div><b>Pedidos</b></div>
      <button class="btn primary new" data-new>+ Nuevo pedido</button>
      <h3>Mis pedidos</h3>
      <div class="reqs"><div class="none">Todavía no tienes pedidos.</div></div>
      <div class="me"><div class="av" aria-hidden="true">${esc(initials(me.name))}</div><div class="who">${esc(me.name)}<small>${esc(me.email)}</small></div>
        <div class="acts"><button class="btn" data-theme-t title="${dark ? 'Tema claro' : 'Tema oscuro'}" aria-label="${dark ? 'Tema claro' : 'Tema oscuro'}">${dark ? '☀' : '☾'}</button><button class="btn" data-logout>Salir</button></div></div>
    </aside>
    <main class="main">
      <div class="top"><button class="menu-btn" data-menu aria-label="Mis pedidos"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><h2>Nuevo pedido</h2></div>
      <div class="content"><div class="content-in">
        ${apps.length ? `<h3>¿En qué aplicación es el cambio?</h3>
        <p>Solo ves las que el equipo te habilitó.</p>
        <div class="projects">${apps.map((a) => `<button class="proj" data-app="${esc(key(a))}" aria-pressed="${key(a) === S.picked}"><span class="org">${esc(a.org)}</span><b>${esc(a.name)}</b>${a.description ? `<span>${esc(a.description)}</span>` : ''}</button>`).join('')}</div>
        <div class="note"><b>Qué se puede pedir aquí:</b> ajustes chicos sobre lo que ya existe: un texto, un enlace, un dato que falta en una pantalla, algo que se ve mal en el teléfono.
          Lo que sea un proyecto o una función nueva lo recibe el equipo de desarrollo, y te avisamos cuando esté resuelto.</div>
        <ul class="tips"><li>Cuenta qué quieres cambiar y en qué pantalla.</li><li>Pega o arrastra capturas: ayudan mucho.</li><li>ronin te puede hacer preguntas antes de proponer el cambio.</li></ul>`
        : '<h3>Todavía no tienes aplicaciones habilitadas</h3><p>Pídele al equipo de desarrollo que te habilite las aplicaciones en las que necesitas pedir ajustes.</p>'}
      </div></div>
      <div class="soon">Muy pronto vas a poder enviar tus pedidos desde aquí.</div>
    </main>
  </div>`;
}

const key = (a) => `${a.repo}:${a.app}`;

// ---------- render
function render(keep = {}) {
  const root = $('#root');
  if (S.view === 'app') root.innerHTML = appHTML();
  else if (S.view === 'password') root.innerHTML = passwordHTML();
  else root.innerHTML = loginHTML();
  const form = $('#f');
  if (form) form.onsubmit = S.view === 'password' ? submitPassword : submitLogin;
  if (keep.email !== undefined && $('#em')) $('#em').value = keep.email;
  const first = $('#f input');
  if (first && !S.busy && !first.value) first.focus();
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
  } else if ('menu' in t.dataset) {
    S.menu = !S.menu;
    render();
  } else if ('new' in t.dataset) {
    S.menu = false;
    render();
  } else if ('themeT' in t.dataset) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ronin-portal-theme', next); } catch { /* sin storage */ }
    render();
  } else if ('logout' in t.dataset) {
    await api('/api/portal/logout', {}).catch(() => {});
    S.me = null; S.view = 'login'; S.error = null; S.info = null;
    render();
  }
});

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
    S.view = 'app';
  } catch {
    S.view = 'login';
  }
  render();
}

start();
