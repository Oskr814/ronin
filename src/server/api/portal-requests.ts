import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../core/logger.js';
import { grantedApps, type PortalApp } from '../../portal/apps.js';
import { IMAGE_TYPES, ImageError, MAX_IMAGE_BYTES, MAX_IMAGES, parseImages } from '../../portal/images.js';
import { launchPortalWorker } from '../../portal/launch.js';
import { decideRequest } from '../../portal/prototype.js';
import { addPersonMessage, createRequest, getRequest, listRequestsOf, MAX_PROTOTYPES, requestImagePath, RequestError, startedToday, TEXT_MAX, type PortalRequest } from '../../portal/requests.js';
import { json, portalUser, readJson, type PortalConfig, type PortalDeps } from './portal.js';

// A person's requests in the portal (#114), always behind their session and
// only their own:
//   GET  /api/portal/requests                     their requests, newest first
//   POST /api/portal/requests                     { repo, app, text, images? }: a new one; ronin starts reading it
//   GET  /api/portal/requests/<n>                 one, with its conversation
//   POST /api/portal/requests/<n>/messages        { text, images? }: their answer, or an adjustment to the prototype
//   POST /api/portal/requests/<n>/decision        { decision: 'aprobar' | 'rechazar', text? }: on the prototype on screen
//   GET  /api/portal/requests/<n>/images/<file>   an image of the conversation
// Images travel as data URLs in the JSON, so these bodies can be large.

const MAX_REQUEST_BODY = MAX_IMAGES * Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

// What the person sees of a request: never the team's technical summary,
// the prototype's instruction or its diff.
function personView(r: PortalRequest, app: PortalApp | undefined) {
  return {
    number: r.number,
    title: r.title,
    repo: r.repo,
    app: r.app,
    appName: app ? `${app.org} · ${app.name}` : r.app,
    status: r.status,
    // Adjustments the person may still ask for on the prototype.
    adjustmentsLeft: Math.max(0, MAX_PROTOTYPES - (r.prototypes?.length ?? 0)),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messages: r.messages.map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      at: m.at,
      images: m.images.map((file) => `/api/portal/requests/${r.number}/images/${file}`),
      ...(m.captions ? { captions: m.captions } : {}),
    })),
  };
}

function summaryView(r: PortalRequest, app: PortalApp | undefined) {
  const { messages, ...rest } = personView(r, app);
  return { ...rest, messages: messages.length };
}

function message(body: Record<string, unknown>) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > TEXT_MAX) throw new RequestError(`El mensaje puede tener hasta ${TEXT_MAX} caracteres.`);
  const images = parseImages(body.images);
  if (!text && !images.length) throw new RequestError('Escribe qué necesitas o adjunta una imagen.');
  return { text, images };
}

export async function handlePortalRequests(req: IncomingMessage, res: ServerResponse, path: string, config: PortalConfig, deps: PortalDeps): Promise<void> {
  const user = await portalUser(req, config);
  if (!user) {
    json(res, 401, { error: 'sin sesión' });
    return;
  }
  const method = req.method ?? 'GET';
  const apps = grantedApps(user.grants, await deps.entries());
  const appOf = (r: PortalRequest) => apps.find((a) => a.repo === r.repo && a.app === r.app);
  const launch = deps.launch ?? launchPortalWorker;

  try {
    if (path === '/api/portal/requests' && method === 'GET') {
      json(res, 200, (await listRequestsOf(user.id)).map((r) => summaryView(r, appOf(r))));
      return;
    }

    if (path === '/api/portal/requests' && method === 'POST') {
      const body = await readJson(req, MAX_REQUEST_BODY);
      if (!body) throw new RequestError('El pedido no llegó bien (¿imágenes muy pesadas?).');
      const app = apps.find((a) => a.repo === body.repo && a.app === body.app);
      if (!app) throw new RequestError('No tienes habilitada esa aplicación.');
      const limit = user.dailyLimit ?? config.dailyLimit;
      if ((await startedToday(user.id)) >= limit) {
        json(res, 429, { error: `Llegaste al tope de ${limit} ${limit === 1 ? 'pedido' : 'pedidos'} por hoy. Mañana puedes enviar más.` });
        return;
      }
      const request = await createRequest({ userId: user.id, repo: app.repo, app: app.app, ...message(body) });
      log.info(`portal: ${user.email} abrió el pedido P-${request.number} en ${app.repo} · ${app.app}`);
      await launch(request.number);
      json(res, 200, personView((await getRequest(request.number)) ?? request, app));
      return;
    }

    const one = /^\/api\/portal\/requests\/(\d+)(?:\/(messages|decision|images\/([\w.-]+)))?$/.exec(path);
    const request = one ? await getRequest(Number(one[1])) : undefined;
    // Someone else's request is as good as missing.
    if (!one || !request || request.userId !== user.id) {
      json(res, 404, { error: 'No existe ese pedido.' });
      return;
    }

    if (!one[2] && method === 'GET') {
      json(res, 200, personView(request, appOf(request)));
      return;
    }

    if (one[2] === 'messages' && method === 'POST') {
      const body = await readJson(req, MAX_REQUEST_BODY);
      if (!body) throw new RequestError('El mensaje no llegó bien (¿imágenes muy pesadas?).');
      const { text, images } = message(body);
      const updated = await addPersonMessage(request.number, text, images);
      await launch(request.number);
      json(res, 200, personView((await getRequest(request.number)) ?? updated, appOf(request)));
      return;
    }

    if (one[2] === 'decision' && method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const decision = body?.decision;
      if (decision !== 'aprobar' && decision !== 'rechazar') throw new RequestError('Elige si lo apruebas o no.');
      const note = typeof body?.text === 'string' ? body.text.trim() : '';
      if (note.length > TEXT_MAX) throw new RequestError(`El mensaje puede tener hasta ${TEXT_MAX} caracteres.`);
      json(res, 200, personView(await decideRequest(request.number, decision, note, launch), appOf(request)));
      return;
    }

    const file = one[3];
    if (file && method === 'GET' && request.messages.some((m) => m.images.includes(file))) {
      const ext = file.split('.').pop() as keyof typeof IMAGE_TYPES;
      res.writeHead(200, { 'Content-Type': IMAGE_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' })
        .end(await readFile(requestImagePath(request.number, file)));
      return;
    }

    json(res, 404, { error: 'No existe.' });
  } catch (error) {
    if (error instanceof RequestError || error instanceof ImageError) json(res, 400, { error: error.message });
    else throw error;
  }
}
