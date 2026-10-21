import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { log } from '../../../platform/logger.js';
import type { Access } from '../../../domains/access/access.js';
import type { Session } from './auth.js';

// What every route group in Hono shares (#235, stage 6): the API moves to it
// a group at a time, mounted inside the current Node handlers, so the old
// routes keep answering until theirs moves.

// The Node request under each route (c.env.incoming): its cookies, its socket.
export type NodeEnv = { Bindings: HttpBindings };

// The dashboard's routes (on the tailnet listener): who's asking, and the
// repos they see (access/access.ts), already checked by tailnet.ts.
export type DashboardBindings = HttpBindings & { session: Session; access: Access };
export type DashboardEnv = { Bindings: DashboardBindings };

// A Hono app answering one Node request, with `extra` next to it in c.env
// (the dashboard's session and access). Plain writeHead and end, which is
// all the dashboard's handlers (and their tests' stand-ins) need.
export async function answer<E extends object>(app: Hono<{ Bindings: HttpBindings & E }>, req: IncomingMessage, res: ServerResponse, extra: E): Promise<void> {
  const method = req.method ?? 'GET';
  const chunks: Buffer[] = [];
  if (method !== 'GET' && method !== 'HEAD') for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  const request = new Request(`http://localhost${req.url ?? '/'}`, { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const response = await app.fetch(request, { incoming: req, outgoing: res, ...extra });
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  // A stream of events (a run as it happens) goes out as it comes, until it
  // ends or the person leaves; anything else, whole.
  if (response.body && (response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    res.writeHead(response.status, out);
    const reader = response.body.getReader();
    req.on('close', () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      res.write(value);
    }
    res.end();
    return;
  }
  res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
}

// A JSON body of at most `max` bytes, an object, or a 400 with `bad`: what
// the page shows when it didn't arrive whole (images too heavy, cut off).
// Read once here; the validator after it takes it from Hono's cache.
export function jsonBody(max: number, bad: string): MiddlewareHandler {
  const limit = bodyLimit({ maxSize: max, onError: (c) => c.json({ error: bad }, 400) });
  return (c, next) => limit(c, async () => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      body = null;
    }
    // Answered here, not returned: bodyLimit doesn't pass on what this returns.
    if (!body || typeof body !== 'object' || Array.isArray(body)) c.res = c.json({ error: bad }, 400);
    else await next();
  });
}

// The body checked against its schema: the first problem, as a 400 with the
// schema's own message for it.
export const body = <T extends ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? 'pedido inválido' }, 400);
  });

// The errors of a route group: a domain error (one of `domain`: the person
// asked for something that can't be) is a 400 with its message, which the
// page shows as is; anything else, a 500 with an id the log has too.
export function onError(domain: Array<new (...args: never[]) => Error> = []) {
  return (error: Error, c: Context) => {
    if (error instanceof HTTPException) return error.getResponse();
    // Its own status if it has one (a 404, a 409), or a 400, and what else
    // it has to say (`details`: a deploy's plan as it is now).
    if (domain.some((type) => error instanceof type)) {
      const { status = 400, details = {} } = error as { status?: number; details?: object };
      return c.json({ error: error.message, ...details }, status as 400);
    }
    const id = randomBytes(4).toString('hex');
    log.error(`${c.req.method} ${c.req.path} falló (error ${id})`, error);
    return c.json({ error: `Algo falló de nuestro lado (error ${id}).` }, 500);
  };
}
