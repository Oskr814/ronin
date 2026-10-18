import type { RepoEntry } from '../../core/repo-context.js';
import { log } from '../../core/logger.js';
import { AccountError, adminView, createUser, getUser, listUsers, updateUser, type PortalUser, type UserFields } from '../../portal/accounts.js';
import { portalApps, validGrants } from '../../portal/apps.js';
import { startedTodayByUser } from '../../portal/requests.js';
import { sendPasswordLink, type Send } from '../../portal/send-link.js';
import { record } from './ajustes.js';

// The request portal's accounts from the dashboard (#114), for its admins
// only; since #174 they're shown in Ajustes → Usuarios, with the role
// Usuario, and every change goes to the Registro:
//   GET  /api/portal-admin                   the accounts, and the apps that can be granted
//   POST /api/portal-admin/users             { email, name, grants, dailyLimit? }: creates one and emails the invitation
//   POST /api/portal-admin/users/<id>        { name?, grants?, dailyLimit?, disabled? }
//   POST /api/portal-admin/users/<id>/link   emails a new link to set the password
// When an email fails, the answer carries the link so the admin can pass it on.

export class PortalAdminError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface PortalAdminContext {
  // PORTAL_URL; empty while the portal isn't configured.
  url: string;
  enabled: boolean;
  dailyLimit: number;
  entries: RepoEntry[];
  admin: string;
  send?: Send;
}

export async function portalAdminView(ctx: PortalAdminContext) {
  const [users, used] = await Promise.all([listUsers(), startedTodayByUser()]);
  return {
    enabled: ctx.enabled,
    url: ctx.url,
    dailyLimit: ctx.dailyLimit,
    apps: portalApps(ctx.entries),
    // Each one with their requests today, against their daily limit.
    users: users
      .map((u) => ({ ...adminView(u), today: { used: used.get(u.id) ?? 0, limit: u.dailyLimit ?? ctx.dailyLimit } }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es')),
  };
}

function fields(body: Record<string, unknown>, entries: RepoEntry[], creating: boolean): Partial<UserFields> & { disabled?: boolean } {
  const out: Partial<UserFields> & { disabled?: boolean } = {};
  if (creating || body.name !== undefined) {
    if (typeof body.name !== 'string') throw new PortalAdminError('Falta el nombre.');
    out.name = body.name;
  }
  if (creating || body.grants !== undefined) {
    const grants = validGrants(body.grants ?? [], entries);
    if (!grants) throw new PortalAdminError('Alguna de las apps no está en el portal (portal.apps de repos.json).');
    out.grants = grants;
  }
  if (body.dailyLimit !== undefined) {
    if (body.dailyLimit !== null && typeof body.dailyLimit !== 'number') throw new PortalAdminError('El tope diario debe ser un número.');
    out.dailyLimit = body.dailyLimit as number | null;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') throw new PortalAdminError('"disabled" debe ser true o false.');
    out.disabled = body.disabled;
  }
  return out;
}

// What an edit changed, in words, for the Registro.
function accountChanges(before: PortalUser, after: PortalUser): Array<{ what: string; from: string; to: string }> {
  const apps = (u: PortalUser) => u.grants.map((g) => `${g.repo}:${g.app}`).sort().join(', ') || 'ninguna';
  const limit = (u: PortalUser) => (u.dailyLimit === undefined ? 'el de General' : String(u.dailyLimit));
  const changes = [];
  if (before.name !== after.name) changes.push({ what: 'nombre', from: before.name, to: after.name });
  if (apps(before) !== apps(after)) changes.push({ what: 'apps', from: apps(before), to: apps(after) });
  if (limit(before) !== limit(after)) changes.push({ what: 'pedidos por día', from: limit(before), to: limit(after) });
  if (before.disabled !== after.disabled) changes.push({ what: 'cuenta', from: before.disabled ? 'desactivada' : 'activa', to: after.disabled ? 'desactivada' : 'activa' });
  return changes;
}

const linkResult = (sent: boolean, url: string) => (sent ? { sent } : { sent, url });

export async function runPortalAdmin(ctx: PortalAdminContext, path: string, body: Record<string, unknown>) {
  if (!ctx.enabled) throw new PortalAdminError('El portal no está configurado: falta PORTAL_URL o PORTAL_SESSION_SECRET en .env.', 409);
  try {
    if (path === '/api/portal-admin/users') {
      if (typeof body.email !== 'string') throw new PortalAdminError('Falta el correo.');
      const user = await createUser({ ...(fields(body, ctx.entries, true) as UserFields), email: body.email, createdBy: ctx.admin });
      log.info(`portal: ${ctx.admin} creó la cuenta de ${user.email}`);
      await record({ login: ctx.admin, what: `Usuarios · ${user.email}`, from: '—', to: 'invitado al portal' });
      const { sent, url } = await sendPasswordLink(user, 'invite', { portalUrl: ctx.url, entries: ctx.entries, send: ctx.send });
      return { user: adminView((await getUser(user.id)) ?? user), ...linkResult(sent, url) };
    }
    const link = /^\/api\/portal-admin\/users\/([\w-]+)\/link$/.exec(path);
    if (link) {
      const user = await getUser(link[1]);
      if (!user) throw new PortalAdminError('No existe esa cuenta.', 404);
      const { sent, url } = await sendPasswordLink(user, user.passwordHash ? 'reset' : 'invite', { portalUrl: ctx.url, entries: ctx.entries, send: ctx.send });
      await record({ login: ctx.admin, what: `Usuarios · ${user.email}`, from: '—', to: user.passwordHash ? 'enlace para nueva contraseña' : 'invitación de nuevo' });
      return { user: adminView((await getUser(user.id)) ?? user), ...linkResult(sent, url) };
    }
    const edit = /^\/api\/portal-admin\/users\/([\w-]+)$/.exec(path);
    if (edit) {
      const before = await getUser(edit[1]);
      const user = await updateUser(edit[1], fields(body, ctx.entries, false));
      if (before) for (const change of accountChanges(before, user)) await record({ login: ctx.admin, what: `Usuarios · ${user.email} · ${change.what}`, from: change.from, to: change.to });
      log.info(`portal: ${ctx.admin} cambió la cuenta de ${user.email}${body.disabled === true ? ' (desactivada)' : body.disabled === false ? ' (reactivada)' : ''}`);
      return { user: adminView(user) };
    }
  } catch (error) {
    if (error instanceof AccountError) throw new PortalAdminError(error.message);
    throw error;
  }
  throw new PortalAdminError('No existe.', 404);
}
