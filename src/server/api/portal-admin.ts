import type { RepoEntry } from '../../core/repo-context.js';
import { log } from '../../core/logger.js';
import { AccountError, adminView, createUser, getUser, listUsers, updateUser, type UserFields } from '../../portal/accounts.js';
import { portalApps, validGrants } from '../../portal/apps.js';
import { sendPasswordLink, type Send } from '../../portal/send-link.js';

// The request portal's accounts from the dashboard (#114), for its admins
// (DASHBOARD_ADMINS) only:
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
  return {
    enabled: ctx.enabled,
    url: ctx.url,
    dailyLimit: ctx.dailyLimit,
    apps: portalApps(ctx.entries),
    users: (await listUsers()).map(adminView).sort((a, b) => a.name.localeCompare(b.name, 'es')),
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

const linkResult = (sent: boolean, url: string) => (sent ? { sent } : { sent, url });

export async function runPortalAdmin(ctx: PortalAdminContext, path: string, body: Record<string, unknown>) {
  if (!ctx.enabled) throw new PortalAdminError('El portal no está configurado: falta PORTAL_URL o PORTAL_SESSION_SECRET en .env.', 409);
  try {
    if (path === '/api/portal-admin/users') {
      if (typeof body.email !== 'string') throw new PortalAdminError('Falta el correo.');
      const user = await createUser({ ...(fields(body, ctx.entries, true) as UserFields), email: body.email, createdBy: ctx.admin });
      log.info(`portal: ${ctx.admin} creó la cuenta de ${user.email}`);
      const { sent, url } = await sendPasswordLink(user, 'invite', { portalUrl: ctx.url, entries: ctx.entries, send: ctx.send });
      return { user: adminView((await getUser(user.id)) ?? user), ...linkResult(sent, url) };
    }
    const link = /^\/api\/portal-admin\/users\/([\w-]+)\/link$/.exec(path);
    if (link) {
      const user = await getUser(link[1]);
      if (!user) throw new PortalAdminError('No existe esa cuenta.', 404);
      const { sent, url } = await sendPasswordLink(user, user.passwordHash ? 'reset' : 'invite', { portalUrl: ctx.url, entries: ctx.entries, send: ctx.send });
      return { user: adminView((await getUser(user.id)) ?? user), ...linkResult(sent, url) };
    }
    const edit = /^\/api\/portal-admin\/users\/([\w-]+)$/.exec(path);
    if (edit) {
      const user = await updateUser(edit[1], fields(body, ctx.entries, false));
      log.info(`portal: ${ctx.admin} cambió la cuenta de ${user.email}${body.disabled === true ? ' (desactivada)' : body.disabled === false ? ' (reactivada)' : ''}`);
      return { user: adminView(user) };
    }
  } catch (error) {
    if (error instanceof AccountError) throw new PortalAdminError(error.message);
    throw error;
  }
  throw new PortalAdminError('No existe.', 404);
}
