import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../../platform/config/config.js';
import { loadRepos } from '../../platform/config/repos.js';
import { body, jsonBody, onError, type DashboardEnv } from '../../apps/api/http/hono.js';
import { sees, type Access } from '../access/access.js';
import { HISTORY_DAYS } from '../runs/data.js';
import { requestDetail, requestImage, requestPatch, requestRow } from './board.js';
import { createAccount, editAccount, PortalAdminError, portalAdminView, sendAccountLink, type PortalAdminContext } from './admin.js';
import { visibleRepos, visibleRuns } from '../access/visible.js';
import { missingPortalConfig } from '../../apps/api/http/portal.js';
import { listUsers } from './accounts.js';
import { getRequest, listRequests } from './requests.js';

// The portal from the dashboard, in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them:
//   /api/pedidos…        the requests of the repos the session sees (#132)
//   /api/portal-admin…   the portal's accounts, for the dashboard's admins (#114)

// GET /api/pedidos                         the requests, newest first
// GET /api/pedidos/<n>                     one, with its activity and runs
// GET /api/pedidos/<n>/img/<file>          an image of its conversation
// GET /api/pedidos/<n>/prototipo/<round>   a prototype's diff
// GET /api/pedidos/<n>/reproduccion/<round>  a reproduction's diff
// A request of a repo the session sees, or none: one it doesn't see is one
// that isn't there.
async function visibleRequest(access: Access, n: string) {
  const request = /^\d+$/.test(n) ? await getRequest(Number(n)) : undefined;
  return request && sees(access, request.repo) ? request : undefined;
}

export function pedidosRoutes() {
  const missing = { error: 'no existe ese pedido' };
  return new Hono<DashboardEnv>()
    .get('/', async (c) => {
      const access = c.env.access;
      const requests = (await listRequests()).filter((r) => sees(access, r.repo));
      const users = new Map(requests.length ? (await listUsers()).map((u) => [u.id, u]) : []);
      const [entries, runs] = await Promise.all([visibleRepos(access), visibleRuns(access, HISTORY_DAYS)]);
      return c.json({ requests: requests.map((r) => requestRow(r, users.get(r.userId), entries, runs)).sort((a, b) => b.number - a.number) }, 200);
    })
    .get('/:n', async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const users = new Map((await listUsers()).map((u) => [u.id, u]));
      return c.json(requestDetail(request, users.get(request.userId), await visibleRepos(c.env.access), await visibleRuns(c.env.access, HISTORY_DAYS)), 200);
    })
    .get('/:n/img/:file', async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const image = await requestImage(request, c.req.param('file'));
      if (!image) return c.json({ error: 'no existe esa imagen' }, 404);
      return c.body(new Uint8Array(image.data), 200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400' });
    })
    .get('/:n/:of{prototipo|reproduccion}/:round', async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const prototype = c.req.param('of') === 'prototipo';
      const patch = await requestPatch(request, Number(c.req.param('round')), prototype ? 'prototype' : 'reproduction');
      if (patch === null) return c.json({ error: prototype ? 'ese prototipo no dejó diff' : 'esa reproducción no dejó diff' }, 404);
      return c.json({ patch }, 200);
    });
}

// GET  /api/portal-admin                   the accounts, and the apps that can be granted
// POST /api/portal-admin/users             { email, name, grants, dailyLimit? }: creates one and emails the invitation
// POST /api/portal-admin/users/<id>        { name?, grants?, dailyLimit?, disabled? }
// POST /api/portal-admin/users/<id>/link   emails a new link to set the password
// The fields are checked by portal/admin.ts, with what's wrong in words.
export function portalAdminRoutes() {
  const account = body(z.record(z.string(), z.unknown()));
  const json = () => jsonBody(64 * 1024, 'se espera JSON');
  const ctx = async (admin: string): Promise<PortalAdminContext> => ({
    url: config.portal.url,
    enabled: missingPortalConfig(config.portal).length === 0,
    dailyLimit: config.portal.dailyLimit,
    entries: await loadRepos(),
    admin,
  });
  return new Hono<DashboardEnv>()
    .onError(onError([PortalAdminError]))
    .use('*', async (c, next) => {
      if (!c.env.access.admin) return c.json({ error: 'solo los administradores del tablero manejan las cuentas del portal' }, 403);
      // A change only as JSON, which a plain HTML form can't send.
      if (c.req.method !== 'GET' && !(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: 'se espera JSON' }, 415);
      await next();
    })
    .get('/', async (c) => c.json(await portalAdminView(await ctx(c.env.session.login)), 200))
    .post('/users', json(), account, async (c) => c.json(await createAccount(await ctx(c.env.session.login), c.req.valid('json')), 200))
    .post('/users/:id/link', async (c) => c.json(await sendAccountLink(await ctx(c.env.session.login), c.req.param('id')), 200))
    .post('/users/:id', json(), account, async (c) => c.json(await editAccount(await ctx(c.env.session.login), c.req.param('id'), c.req.valid('json')), 200));
}
