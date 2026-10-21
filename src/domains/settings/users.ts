import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';
import { AjustesError, notificaciones, record } from './settings.js';
import { applyTeam, entradaOf, envAdmins, isAdmin, isSetName, permsFor, readTeam, SETS, withTeam, type Member, type RepoGrant, type TeamFile } from '../access/team.js';
import { timed } from '../../platform/timing.js';

// Ajustes → Usuarios (#174, stage 2), admins only:
//   GET  /api/ajustes/usuarios                 the team, who gets in and the default set
//   GET  /api/ajustes/usuarios/<login>         one of them, repo by repo: what GitHub gives and what they can do
//   POST /api/ajustes/usuarios                 { login, role }: adds someone before they come in
//   POST /api/ajustes/usuarios/<login>         { role? | name? | email? | repo?: { repo, set?, custom?, desplegar?, hidden? } }
//   POST /api/ajustes/usuarios/<login>/quitar  takes them off the list
//   POST /api/ajustes/equipo                   { entrada?, porDefecto? }
//
// Every change goes to the Registro and is applied to who gets in right away
// (applyTeam).

const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;
const GITHUB_TTL_MS = 10 * 60_000;
const SET_NAME = { todo: 'Todo', reuniones: 'Reuniones y pedidos', lectura: 'Solo lectura' };
const PERM_NAME = { notas: 'subir notas', aprobar: 'aprobar', acciones: 'acciones', desplegar: 'desplegar' };

async function githubGet(path: string): Promise<Response> {
  return timed('github', () => fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ronin-dashboard' },
    signal: AbortSignal.timeout(15_000),
  }));
}

// What GitHub gives the login on the repo (admin, maintain, write, triage,
// read), asked with ronin's token; null without access. Cached a few
// minutes: the page lists everyone.
const roles = new Map<string, { at: number; role: string | null }>();
export async function githubRole(repo: string, login: string, now = Date.now()): Promise<string | null> {
  const key = `${repo}:${login}`;
  const cached = roles.get(key);
  if (cached && now - cached.at < GITHUB_TTL_MS) return cached.role;
  const response = await githubGet(`repos/${repo}/collaborators/${login}/permission`);
  let role: string | null = null;
  if (response.ok) {
    const body = (await response.json()) as { permission?: string; role_name?: string };
    role = body.role_name ?? body.permission ?? null;
    if (role === 'none') role = null;
  } else if (response.status !== 404) throw new Error(`GitHub respondió ${response.status} al leer el permiso de ${login} en ${repo}`);
  roles.set(key, { at: now, role });
  return role;
}

const ENOUGH = ['triage', 'write', 'maintain', 'admin'];
const githubLets = (role: string | null) => role !== null && ENOUGH.includes(role);

async function rolesOf(login: string, entries: RepoEntry[]) {
  return Promise.all(entries.map(async (entry) => [entry.productRepo, await githubRole(entry.productRepo, login).catch((error) => {
    log.error(`usuarios: no se pudo leer el permiso de ${login} en ${entry.productRepo}`, error);
    return undefined;
  })] as const));
}

function row(team: TeamFile, login: string) {
  const m = team.people[login] ?? {};
  return {
    login,
    ...(m.name ? { name: m.name } : {}),
    ...(m.email ? { email: m.email } : {}),
    role: isAdmin(team, login) ? 'admin' : 'member',
    envAdmin: envAdmins().includes(login),
    ...(m.lastSeenAt ? { lastSeenAt: m.lastSeenAt } : {}),
    ...(m.addedBy ? { addedBy: m.addedBy } : {}),
  };
}

export async function usuariosView(entries: RepoEntry[]): Promise<unknown> {
  const team = await readTeam();
  const logins = [...new Set([...envAdmins(), ...Object.keys(team.people)])].sort();
  const people = await Promise.all(logins.map(async (login) => {
    const github = await rolesOf(login, entries);
    return {
      ...row(team, login),
      repos: github.map(([repo, role]) => {
        const grant = team.people[login]?.repos?.[repo];
        return { repo, github: role ?? null, set: grant?.custom ? 'custom' : grant?.set ?? null, hidden: grant?.hidden === true, desplegar: grant?.desplegar === true };
      }),
    };
  }));
  return { entrada: entradaOf(team), entradaSet: team.entrada !== undefined, porDefecto: team.porDefecto ?? 'todo', envAllowed: (process.env.DASHBOARD_ALLOWED_USERS ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean), people };
}

export async function usuarioView(login: string, entries: RepoEntry[]): Promise<unknown | null> {
  const team = await readTeam();
  if (!team.people[login] && !envAdmins().includes(login)) return null;
  const github = await rolesOf(login, entries);
  return {
    ...row(team, login),
    ...(team.people[login]?.linear ? { linear: team.people[login].linear } : {}),
    porDefecto: team.porDefecto ?? 'todo',
    entrada: entradaOf(team),
    // Theirs to choose; an admin only sees them.
    notificaciones: notificaciones(team.people[login], entries),
    repos: github.map(([repo, role]) => {
      const grant = team.people[login]?.repos?.[repo] ?? {};
      return { repo, github: role ?? null, githubLets: role === undefined ? null : githubLets(role), set: grant.custom ? 'custom' : grant.set ?? null, hidden: grant.hidden === true, perms: permsFor(team, login, repo) };
    }),
  };
}

const normalized = (login: unknown) => (typeof login === 'string' ? login.trim().replace(/^@/, '').toLowerCase() : '');

// POST /api/ajustes/usuarios: someone who hasn't come in yet, to give them a
// role or set their repos before. GitHub must know them.
export async function addUsuario(admin: string, body: Record<string, unknown>): Promise<unknown> {
  const login = normalized(body.login);
  if (!LOGIN_RE.test(login)) throw new AjustesError('Ese no es un login de GitHub.');
  const role = body.role === 'admin' ? 'admin' : 'member';
  const response = await githubGet(`users/${login}`);
  if (response.status === 404) throw new AjustesError(`GitHub no conoce a @${login}.`);
  if (!response.ok) throw new AjustesError(`GitHub respondió ${response.status} al buscar a @${login}.`, { status: 502 });
  const added = await withTeam((team) => {
    if (team.people[login] || envAdmins().includes(login)) return false;
    team.people[login] = { role, addedBy: admin, addedAt: new Date().toISOString() };
    applyTeam(team);
    return true;
  });
  if (!added) throw new AjustesError(`@${login} ya está en la lista.`, { status: 409 });
  await record({ login: admin, what: `Usuarios · @${login}`, from: '—', to: role === 'admin' ? 'agregado como administrador' : 'agregado como miembro' });
  log.info(`usuarios: ${admin} agregó a ${login} (${role})`);
  return { login };
}

const setLabel = (grant: RepoGrant | undefined, team: TeamFile) => (grant?.custom ? 'Personalizado' : grant?.set ? SET_NAME[grant.set] : `Por defecto (${SET_NAME[team.porDefecto ?? 'todo']})`);

// POST /api/ajustes/usuarios/<login>: one change at a time, as the page saves.
export async function updateUsuario(admin: string, login: string, body: Record<string, unknown>, entries: RepoEntry[]): Promise<unknown> {
  const changes: Array<{ what: string; from: string; to: string }> = [];
  await withTeam((team) => {
    if (!team.people[login] && !envAdmins().includes(login)) throw new AjustesError('Esa persona no está en la lista.', { status: 404 });
    const m: Member = { ...(team.people[login] ?? {}) };
    const who = `@${login}`;
    if (body.role !== undefined) {
      if (body.role !== 'admin' && body.role !== 'member') throw new AjustesError('El rol es administrador o miembro.');
      if (envAdmins().includes(login)) throw new AjustesError('Es administrador por DASHBOARD_ADMINS: eso se cambia en .env, no aquí.', { status: 409 });
      if (login === admin && body.role === 'member') throw new AjustesError('No puedes quitarte el rol de administrador a ti mismo: pídeselo a otro administrador.', { status: 409 });
      if ((m.role ?? 'member') !== body.role) changes.push({ what: `${who} · rol`, from: m.role === 'admin' ? 'Administrador' : 'Miembro', to: body.role === 'admin' ? 'Administrador' : 'Miembro' });
      m.role = body.role;
    }
    for (const field of ['name', 'email'] as const) {
      if (body[field] === undefined) continue;
      const value = typeof body[field] === 'string' ? (body[field] as string).trim() : null;
      if (value === null || value.length > (field === 'name' ? 120 : 254)) throw new AjustesError(field === 'name' ? 'El nombre no es válido.' : 'El correo no es válido.');
      const clean = field === 'email' ? value.toLowerCase() : value;
      if (field === 'email' && clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new AjustesError('Ese correo no es válido.');
      if ((m[field] ?? '') !== clean) changes.push({ what: `${who} · ${field === 'name' ? 'nombre' : 'correo'}`, from: m[field] ?? '—', to: clean || '—' });
      if (clean) m[field] = clean;
      else delete m[field];
    }
    if (body.repo !== undefined) {
      const change = (body.repo ?? {}) as Record<string, unknown>;
      const repo = typeof change.repo === 'string' ? change.repo : '';
      if (!entries.some((e) => e.productRepo === repo)) throw new AjustesError('Ese repo no está en repos.json.');
      const before = m.repos?.[repo];
      const grant: RepoGrant = { ...(before ?? {}) };
      if (change.set !== undefined) {
        if (change.set !== null && !isSetName(change.set)) throw new AjustesError('Ese conjunto de permisos no existe.');
        delete grant.custom;
        if (change.set === null) delete grant.set;
        else grant.set = change.set as RepoGrant['set'];
      }
      if (change.custom !== undefined) {
        const c = change.custom as Record<string, unknown> | null;
        if (!c || typeof c !== 'object' || (['notas', 'aprobar', 'acciones'] as const).some((k) => typeof c[k] !== 'boolean')) throw new AjustesError('Faltan los permisos.');
        grant.custom = { notas: c.notas as boolean, aprobar: c.aprobar as boolean, acciones: c.acciones as boolean };
        delete grant.set;
        // Back to a set when it matches one: Personalizado only when it isn't one.
        const same = (Object.keys(SETS) as Array<keyof typeof SETS>).find((name) => (['notas', 'aprobar', 'acciones'] as const).every((k) => SETS[name][k] === grant.custom![k]));
        if (same) {
          delete grant.custom;
          grant.set = same;
        }
      }
      if (change.desplegar !== undefined) {
        if (typeof change.desplegar !== 'boolean') throw new AjustesError('Desplegar es sí o no.');
        if (change.desplegar) grant.desplegar = true;
        else delete grant.desplegar;
      }
      if (change.hidden !== undefined) {
        if (typeof change.hidden !== 'boolean') throw new AjustesError('Oculto es sí o no.');
        if (change.hidden) grant.hidden = true;
        else delete grant.hidden;
      }
      const label = (g: RepoGrant | undefined) => [g?.hidden ? 'oculto' : setLabel(g, team), g?.desplegar ? `${PERM_NAME.desplegar}` : ''].filter(Boolean).join(' + ');
      if (label(before) !== label(grant)) changes.push({ what: `${who} · ${repo}`, from: label(before), to: label(grant) });
      const repos = { ...(m.repos ?? {}) };
      if (Object.keys(grant).length) repos[repo] = grant;
      else delete repos[repo];
      if (Object.keys(repos).length) m.repos = repos;
      else delete m.repos;
    }
    team.people[login] = m;
    applyTeam(team);
  });
  for (const change of changes) await record({ login: admin, ...change });
  return usuarioView(login, entries);
}

// POST /api/ajustes/usuarios/<login>/quitar. With entrada "lista", they're
// out; with "github", they come back with GitHub's repos and the default set.
export async function removeUsuario(admin: string, login: string): Promise<unknown> {
  if (envAdmins().includes(login)) throw new AjustesError('Es administrador por DASHBOARD_ADMINS: se quita en .env.', { status: 409 });
  if (login === admin) throw new AjustesError('No puedes quitarte a ti mismo de la lista.', { status: 409 });
  const removed = await withTeam((team) => {
    if (!team.people[login]) return false;
    delete team.people[login];
    applyTeam(team);
    return true;
  });
  if (!removed) throw new AjustesError('Esa persona no está en la lista.', { status: 404 });
  await record({ login: admin, what: `Usuarios · @${login}`, from: 'en la lista', to: 'quitado' });
  return { ok: true };
}

// POST /api/ajustes/equipo: who gets in, and the default set.
export async function updateEquipo(admin: string, body: Record<string, unknown>): Promise<unknown> {
  const changes: Array<{ what: string; from: string; to: string }> = [];
  const view = await withTeam((team) => {
    if (body.entrada !== undefined) {
      if (body.entrada !== 'github' && body.entrada !== 'lista') throw new AjustesError('La entrada es "github" o "lista".');
      const before = entradaOf(team);
      if (before !== body.entrada) changes.push({ what: 'Usuarios · Entrada', from: before === 'github' ? 'quien tenga acceso en GitHub' : 'solo la lista', to: body.entrada === 'github' ? 'quien tenga acceso en GitHub' : 'solo la lista' });
      team.entrada = body.entrada;
    }
    if (body.porDefecto !== undefined) {
      if (!isSetName(body.porDefecto)) throw new AjustesError('Ese conjunto de permisos no existe.');
      const before = team.porDefecto ?? 'todo';
      if (before !== body.porDefecto) changes.push({ what: 'Usuarios · Permisos por defecto', from: SET_NAME[before], to: SET_NAME[body.porDefecto] });
      team.porDefecto = body.porDefecto;
    }
    applyTeam(team);
    return { entrada: entradaOf(team), porDefecto: team.porDefecto ?? 'todo' };
  });
  for (const change of changes) await record({ login: admin, ...change });
  return view;
}
