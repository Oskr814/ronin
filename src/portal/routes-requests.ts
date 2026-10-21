import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { body, jsonBody, type NodeEnv } from '../server/hono.js';
import type { PortalUser } from './accounts.js';
import { grantedApps, type PortalApp } from './apps.js';
import { cancelRequest } from './cancel.js';
import { portalUser, type PortalConfig, type PortalDeps } from './http.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, parseImages } from './images.js';
import { answerInterview, confirmUnderstood, MAX_CORRECTIONS, MAX_ROUNDS, skipInterview } from './interview.js';
import { launchPortalWorker } from './launch.js';
import { decideRequest } from './prototype.js';
import { addPersonMessage, CANCELLABLE, createRequest, getRequest, listRequestsOf, MAX_PROTOTYPES, requestImagePath, RequestError, startedToday, TEXT_MAX, type PortalRequest } from './requests.js';

// A person's requests in the portal (#114), always behind their session and
// only their own — routes.ts mounts them under /api/portal/requests:
//   GET  /                     their requests, newest first
//   POST /                     { repo, app, text, images? }: a new one; ronin starts reading it
//   GET  /<n>                  one, with its conversation
//   POST /<n>/messages         { text, images? }: their answer, or an adjustment to the prototype
//   POST /<n>/decision         { decision: 'aprobar' | 'rechazar', text? }: on the prototype on screen
//   POST /<n>/interview        { answers, note?, images? }: the answers to ronin's questions (#225)
//   POST /<n>/skip             to the team without answering them, or without confirming the summary
//   POST /<n>/understood       { ok, text?, images? }: the summary after the interview is right, or what to correct
//   POST /<n>/cancel           while nobody took it (cancel.ts)
//   GET  /<n>/images/<file>    an image of the conversation
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
    // Whether it offers "Cancelar": for the team's, the server still checks
    // no one assigned its issue.
    cancellable: CANCELLABLE.includes(r.status),
    // Adjustments the person may still ask for on the prototype.
    adjustmentsLeft: Math.max(0, MAX_PROTOTYPES - (r.prototypes?.length ?? 0)),
    // The interview (#225): the round on screen, of how many, and the
    // corrections to the summary still allowed.
    interview: { round: r.interview?.rounds ?? 0, rounds: MAX_ROUNDS, correctionsLeft: Math.max(0, MAX_CORRECTIONS - (r.interview?.corrections ?? 0)) },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messages: r.messages.map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      at: m.at,
      images: m.images.map((file) => `/api/portal/requests/${r.number}/images/${file}`),
      ...(m.captions ? { captions: m.captions } : {}),
      ...(m.questions ? { questions: m.questions } : {}),
      ...(m.answers ? { answers: m.answers } : {}),
      ...(m.understood ? { understood: m.understood } : {}),
      ...(m.skipped ? { skipped: true } : {}),
      ...(m.confirmed ? { confirmed: true } : {}),
      ...(m.correction ? { correction: true } : {}),
    })),
  };
}

function summaryView(r: PortalRequest, app: PortalApp | undefined) {
  const { messages, ...rest } = personView(r, app);
  return { ...rest, messages: messages.length };
}

// A text the person wrote, trimmed; anything else counts as none.
const written = (tooLong: string) => z.unknown().optional()
  .transform((value) => (typeof value === 'string' ? value.trim() : ''))
  .refine((value) => value.length <= TEXT_MAX, tooLong);
const MESSAGE_TOO_LONG = `El mensaje puede tener hasta ${TEXT_MAX} caracteres.`;

// A message: its text, its images, and at least one of the two.
const messageSchema = z.object({ text: written(MESSAGE_TOO_LONG), images: z.unknown().optional() });
function message(given: z.infer<typeof messageSchema>) {
  const images = parseImages(given.images);
  if (!given.text && !images.length) throw new RequestError('Escribe qué necesitas o adjunta una imagen.');
  return { text: given.text, images };
}

type Vars = { Variables: { user: PortalUser; apps: PortalApp[]; request: PortalRequest } };

export function requestRoutes(config: PortalConfig, deps: PortalDeps) {
  const launch = deps.launch ?? launchPortalWorker;
  const appOf = (apps: PortalApp[], r: PortalRequest) => apps.find((a) => a.repo === r.repo && a.app === r.app);

  const session = createMiddleware<NodeEnv & Vars>(async (c, next) => {
    const user = await portalUser(c.env.incoming, config);
    if (!user) return c.json({ error: 'sin sesión' }, 401);
    c.set('user', user);
    c.set('apps', grantedApps(user.grants, await deps.entries()));
    await next();
  });

  // The request in the path, only if it's the person's: someone else's (or
  // a number that isn't one) is as good as missing.
  const own = createMiddleware<NodeEnv & Vars>(async (c, next) => {
    const n = c.req.param('n') ?? '';
    const request = /^\d+$/.test(n) ? await getRequest(Number(n)) : undefined;
    if (!request || request.userId !== c.get('user').id) return c.json({ error: 'No existe ese pedido.' }, 404);
    c.set('request', request);
    await next();
  });

  // The request as it is now, as the person sees it.
  const fresh = async (apps: PortalApp[], request: PortalRequest) => personView((await getRequest(request.number)) ?? request, appOf(apps, request));

  const N = '/:n';
  return new Hono<NodeEnv & Vars>()
    .use('*', session)
    .use(N, own)
    .use(`${N}/*`, own)

    .get('/', async (c) => {
      const apps = c.get('apps');
      return c.json((await listRequestsOf(c.get('user').id)).map((r) => summaryView(r, appOf(apps, r))));
    })

    .post('/', jsonBody(MAX_REQUEST_BODY, 'El pedido no llegó bien (¿imágenes muy pesadas?).'), body(messageSchema.extend({ repo: z.unknown().optional(), app: z.unknown().optional() })), async (c) => {
      const given = c.req.valid('json');
      const user = c.get('user');
      const app = c.get('apps').find((a) => a.repo === given.repo && a.app === given.app);
      if (!app) throw new RequestError('No tienes habilitada esa aplicación.');
      const limit = user.dailyLimit ?? config.dailyLimit;
      if ((await startedToday(user.id)) >= limit) return c.json({ error: `Llegaste al tope de ${limit} ${limit === 1 ? 'pedido' : 'pedidos'} por hoy. Mañana puedes enviar más.` }, 429);
      const request = await createRequest({ userId: user.id, repo: app.repo, app: app.app, ...message(given) });
      log.info(`portal: ${user.email} abrió el pedido P-${request.number} en ${app.repo} · ${app.app}`);
      await launch(request.number);
      return c.json(await fresh(c.get('apps'), request));
    })

    .get(N, (c) => c.json(personView(c.get('request'), appOf(c.get('apps'), c.get('request')))))

    .post(`${N}/messages`, jsonBody(MAX_REQUEST_BODY, 'El mensaje no llegó bien (¿imágenes muy pesadas?).'), body(messageSchema), async (c) => {
      const request = c.get('request');
      const { text, images } = message(c.req.valid('json'));
      await addPersonMessage(request.number, text, images);
      await launch(request.number);
      return c.json(await fresh(c.get('apps'), request));
    })

    .post(`${N}/decision`, jsonBody(64 * 1024, 'Elige si lo apruebas o no.'), body(z.object({
      decision: z.enum(['aprobar', 'rechazar'], { error: 'Elige si lo apruebas o no.' }),
      text: written(MESSAGE_TOO_LONG),
    })), async (c) => {
      const request = c.get('request');
      const { decision, text } = c.req.valid('json');
      return c.json(personView(await decideRequest(request.number, decision, text, launch), appOf(c.get('apps'), request)));
    })

    .post(`${N}/interview`, jsonBody(MAX_REQUEST_BODY, 'Las respuestas no llegaron bien (¿imágenes muy pesadas?).'), body(z.object({
      answers: z.unknown().optional(),
      note: written(`Lo que agregaste puede tener hasta ${TEXT_MAX} caracteres.`),
      images: z.unknown().optional(),
    })), async (c) => {
      const request = c.get('request');
      const { answers, note, images } = c.req.valid('json');
      await answerInterview(request.number, { answers, note, images: parseImages(images) }, launch);
      return c.json(await fresh(c.get('apps'), request));
    })

    .post(`${N}/skip`, async (c) => {
      const request = c.get('request');
      await skipInterview(request.number, launch);
      return c.json(await fresh(c.get('apps'), request));
    })

    .post(`${N}/understood`, jsonBody(MAX_REQUEST_BODY, 'Elige si está bien o qué corregir.'), body(z.object({
      ok: z.boolean({ error: 'Elige si está bien o qué corregir.' }),
      text: written(MESSAGE_TOO_LONG),
      images: z.unknown().optional(),
    })), async (c) => {
      const request = c.get('request');
      const { ok, text, images } = c.req.valid('json');
      await confirmUnderstood(request.number, ok, text, ok ? [] : parseImages(images), launch);
      return c.json(await fresh(c.get('apps'), request));
    })

    .post(`${N}/cancel`, async (c) => {
      const request = c.get('request');
      return c.json(personView(await cancelRequest(request.number, deps.entries), appOf(c.get('apps'), request)));
    })

    .get(`${N}/images/:file{[\\w.-]+}`, async (c) => {
      const request = c.get('request');
      const file = c.req.param('file');
      if (!request.messages.some((m) => m.images.includes(file))) return c.json({ error: 'No existe.' }, 404);
      const ext = file.split('.').pop() as keyof typeof IMAGE_TYPES;
      return c.body(await readFile(requestImagePath(request.number, file)), 200, {
        'Content-Type': IMAGE_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
        'Content-Disposition': 'inline',
      });
    });
}
