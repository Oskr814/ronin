import { Hono } from 'hono';
import { config } from '@platform/config/config.js';
import { loadRepos } from '@platform/config/repos.js';
import { adminsOnly, anyObject, jsonBody, onError, onlyJson } from '@platform/http/middleware.js';
import type { DashboardEnv } from '../access/http.js';
import { sees, type Access } from '../access/access.js';
import { HISTORY_DAYS } from '../runs/data.js';
import { requestDetail, requestImage, requestPatch, requestRow } from './board.js';
import { createAccount, editAccount, portalAdminView, sendAccountLink, type PortalAdminContext } from './admin.js';
import { refusal, visibleRepos, visibleRuns } from '../access/visible.js';
import { missingPortalConfig } from './http.js';
import { listUsers } from './accounts.js';
import { devDecide, parseDevDecision } from './dev-decision.js';
import { seenByTeam, writeToPerson } from './team-conversation.js';
import { getRequest, listRequests, TEXT_MAX } from './requests.js';
import { MAX_IMAGE_BYTES, MAX_IMAGES, parseImages } from './images.js';

// Four images as data URLs, and the text.
const MAX_MESSAGE_BODY = MAX_IMAGES * Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

// The portal from the dashboard, in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them:
//   /api/requests…        the requests of the repos the session sees (#132)
//   /api/portal-admin…   the portal's accounts, for the dashboard's admins (#114)

// GET /api/requests                         the requests, newest first
// GET /api/requests/<n>                     one, with its activity and runs
// GET /api/requests/<n>/img/<file>          an image of its conversation
// GET /api/requests/<n>/prototype/<round>     a prototype's diff
// GET /api/requests/<n>/reproduction/<round>  a reproduction's diff
// POST /api/requests/<n>/decision           { decision: deploy|review|decline, reason? }: a dev decides it (#353)
// POST /api/requests/<n>/messages           { text, images? }: the team writes to the person (#353)
// A request of a repo the session sees, or none: one it doesn't see is one
// that isn't there.
async function visibleRequest(access: Access, n: string) {
  const request = /^\d+$/.test(n) ? await getRequest(Number(n)) : undefined;
  return request && sees(access, request.repo) ? request : undefined;
}

export function requestsRoutes() {
  const missing = { error: 'no existe ese pedido' };
  return new Hono<DashboardEnv>()
    .onError(onError)
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
      // Someone of the team opened it: the person's answer is seen.
      if (request.personReplied) await seenByTeam(request.number);
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
    .get('/:n/:of{prototype|reproduction}/:round', async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const prototype = c.req.param('of') === 'prototype';
      const patch = await requestPatch(request, Number(c.req.param('round')), prototype ? 'prototype' : 'reproduction');
      if (patch === null) return c.json({ error: prototype ? 'ese prototipo no dejó diff' : 'esa reproducción no dejó diff' }, 404);
      return c.json({ patch }, 200);
    })
    .post('/:n/messages', onlyJson, jsonBody(MAX_MESSAGE_BODY, 'El mensaje no llegó bien (¿imágenes muy pesadas?).'), anyObject(), async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const refused = refusal(c, c.env.access, request.repo, 'acciones');
      if (refused) return refused;
      const body = c.req.valid('json');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text.length > TEXT_MAX) return c.json({ error: `El mensaje puede tener hasta ${TEXT_MAX} caracteres.` }, 400);
      const written = await writeToPerson(request.number, { text, images: parseImages(body.images), by: c.env.session.login });
      const users = new Map((await listUsers()).map((u) => [u.id, u]));
      return c.json(requestDetail(written, users.get(written.userId), await visibleRepos(c.env.access), await visibleRuns(c.env.access, HISTORY_DAYS)), 200);
    })
    // Making it or not is the repo's actions; deploying it without anyone
    // else's review, its deploys too.
    .post('/:n/decision', onlyJson, jsonBody(16 * 1024, 'falta la decisión'), anyObject(), async (c) => {
      const request = await visibleRequest(c.env.access, c.req.param('n'));
      if (!request) return c.json(missing, 404);
      const input = parseDevDecision(c.req.valid('json'));
      for (const perm of input.decision === 'deploy' ? (['acciones', 'desplegar'] as const) : (['acciones'] as const)) {
        const refused = refusal(c, c.env.access, request.repo, perm);
        if (refused) return refused;
      }
      const { session } = c.env;
      await devDecide(request.number, { ...input, by: session.login, ...(input.decision === 'deploy' ? { token: session.token } : {}) });
      const users = new Map((await listUsers()).map((u) => [u.id, u]));
      const decided = (await getRequest(request.number))!;
      return c.json(requestDetail(decided, users.get(decided.userId), await visibleRepos(c.env.access), await visibleRuns(c.env.access, HISTORY_DAYS)), 200);
    });
}

// GET  /api/portal-admin                   the accounts, and the apps that can be granted
// POST /api/portal-admin/users             { email, name, grants, dailyLimit? }: creates one and emails the invitation
// POST /api/portal-admin/users/<id>        { name?, grants?, dailyLimit?, disabled? }
// POST /api/portal-admin/users/<id>/link   emails a new link to set the password
// The fields are checked by portal/admin.ts, with what's wrong in words.
export function portalAdminRoutes() {
  const account = anyObject();
  const json = () => jsonBody(64 * 1024, 'se espera JSON');
  const ctx = async (admin: string): Promise<PortalAdminContext> => ({
    url: config.portal.url,
    enabled: missingPortalConfig(config.portal).length === 0,
    dailyLimit: config.portal.dailyLimit,
    entries: await loadRepos(),
    admin,
  });
  return new Hono<DashboardEnv>()
    .onError(onError)
    .use('*', adminsOnly('solo los administradores del tablero manejan las cuentas del portal'), onlyJson)
    .get('/', async (c) => c.json(await portalAdminView(await ctx(c.env.session.login)), 200))
    .post('/users', json(), account, async (c) => c.json(await createAccount(await ctx(c.env.session.login), c.req.valid('json')), 200))
    .post('/users/:id/link', async (c) => c.json(await sendAccountLink(await ctx(c.env.session.login), c.req.param('id')), 200))
    .post('/users/:id', json(), account, async (c) => c.json(await editAccount(await ctx(c.env.session.login), c.req.param('id'), c.req.valid('json')), 200));
}
