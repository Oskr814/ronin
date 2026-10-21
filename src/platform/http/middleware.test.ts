import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import { adminsOnly, anyObject, body, jsonBody, onError, onlyJson, repoParam } from './middleware.js';

class NotHere extends DomainError {}

const app = (admin = true) => new Hono<{ Bindings: { access: { admin: boolean } } }>()
  .onError(onError)
  .use('*', async (c, next) => {
    c.env = { access: { admin } };
    await next();
  })
  .get('/domain', () => {
    throw new NotHere('no está', { status: 404, details: { number: 3 } });
  })
  .get('/plain', () => {
    throw new DomainError('no se puede');
  })
  .get('/ours', () => {
    throw new Error('se rompió');
  })
  .get('/admins', adminsOnly('solo admins'), (c) => c.json({ ok: true }))
  .get('/:owner/:name/repo', (c) => c.json({ repo: repoParam(c) }))
  .on(['GET', 'POST'], '/json', onlyJson, (c) => c.json({ ok: true }))
  .post('/body', onlyJson, jsonBody(64, 'no llegó bien'), body(z.object({ n: z.number({ error: 'falta n' }) })), (c) => c.json(c.req.valid('json')))
  .post('/any', onlyJson, jsonBody(64, 'no llegó bien'), anyObject(), (c) => c.json(c.req.valid('json')));

const post = (path: string, data: string, type = 'application/json') => app().request(path, { method: 'POST', headers: { 'Content-Type': type }, body: data });

describe('onError', () => {
  it('answers a DomainError with its status, message and details, 400 when it has no status', async () => {
    const res = await app().request('/domain');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no está', number: 3 });
    const plain = await app().request('/plain');
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({ error: 'no se puede' });
  });

  it('answers anything else with a 500 and an id, never its message', async () => {
    const res = await app().request('/ours');
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).toMatch(/^Algo falló de nuestro lado \(error [0-9a-f]{8}\)\.$/);
  });
});

describe('the checks', () => {
  it('lets only admins through', async () => {
    expect((await app(false).request('/admins')).status).toBe(403);
    expect((await app(true).request('/admins')).status).toBe(200);
  });

  it('takes changes only as JSON, and lets reads through', async () => {
    expect((await app().request('/json')).status).toBe(200);
    expect((await post('/json', 'a=1', 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await post('/json', '{}')).status).toBe(200);
  });

  it('checks the body: an object, within the limit, and its schema', async () => {
    expect(await (await post('/body', '{"n": 1}')).json()).toEqual({ n: 1 });
    expect(await (await post('/body', '[1]')).json()).toEqual({ error: 'no llegó bien' });
    expect(await (await post('/body', `{"n": 1, "x": "${'a'.repeat(100)}"}`)).json()).toEqual({ error: 'no llegó bien' });
    expect(await (await post('/body', '{"m": 1}')).json()).toEqual({ error: 'falta n' });
    expect(await (await post('/any', '{"a": [1]}')).json()).toEqual({ a: [1] });
  });

  it('reads the repo of the path', async () => {
    expect(await (await app().request('/acme/tienda/repo')).json()).toEqual({ repo: 'acme/tienda' });
  });
});

describe('DomainError', () => {
  it('is named after its class', () => {
    expect(new NotHere('x').name).toBe('NotHere');
  });
});
