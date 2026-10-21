import { randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, type ZodType } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { DomainError } from '../errors.js';
import { log } from '../logger.js';

// What every route group in Hono shares (#235, stage 6): the checks a
// request goes through before its handler, and how an error is answered.
// A domain's routes.ts uses these instead of writing its own.

// The Node request under each route (c.env.incoming): its cookies, its socket.
export type NodeEnv = { Bindings: HttpBindings };

// Changes come as JSON, or a 415: a form posted from another site never
// passes for one of the page's own requests. Reads go through.
export const onlyJson: MiddlewareHandler = async (c, next) =>
  c.req.method === 'GET' || c.req.method === 'HEAD' || (c.req.header('content-type') ?? '').startsWith('application/json') ? next() : c.json({ error: 'se espera JSON' }, 415);

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

// Any JSON object, for a handler that checks its fields itself.
export const anyObject = () => body(z.record(z.string(), z.unknown()));

// Only the dashboard's admins, or a 403 with `refusal`.
export const adminsOnly = (refusal: string): MiddlewareHandler<{ Bindings: { access: { admin: boolean } } }> => async (c, next) =>
  (c.env.access.admin ? next() : c.json({ error: refusal }, 403));

// The repo a path names, as /:owner/:name.
export const repoParam = (c: Context) => `${c.req.param('owner')}/${c.req.param('name')}`;

// The errors of a route group: a DomainError (the person asked for something
// that can't be) is its status with its message, which the page shows as is,
// and its details; anything else, a 500 with an id the log has too.
export function onError(error: Error, c: Context): Response {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof DomainError) return c.json({ error: error.message, ...error.details }, error.status as ContentfulStatusCode);
  const id = randomBytes(4).toString('hex');
  log.error(`${c.req.method} ${c.req.path} falló (error ${id})`, error);
  return c.json({ error: `Algo falló de nuestro lado (error ${id}).` }, 500);
}
