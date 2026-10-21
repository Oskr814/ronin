import { randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { log } from '../core/logger.js';

// What every route group in Hono shares (#235, stage 6): the API moves to it
// a group at a time, mounted inside the current Node handlers, so the old
// routes keep answering until theirs moves.

// The Node request under each route (c.env.incoming): its cookies, its socket.
export type NodeEnv = { Bindings: HttpBindings };

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
    if (domain.some((type) => error instanceof type)) return c.json({ error: error.message }, 400);
    const id = randomBytes(4).toString('hex');
    log.error(`${c.req.method} ${c.req.path} falló (error ${id})`, error);
    return c.json({ error: `Algo falló de nuestro lado (error ${id}).` }, 500);
  };
}
