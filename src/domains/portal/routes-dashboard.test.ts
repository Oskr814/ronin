import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';

vi.mock('../../platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('../../platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));
// The portal configured, as on the server.
vi.mock('../../platform/config/config.js', async (importOriginal) => {
  const { config } = await importOriginal<typeof import('../../platform/config/config.js')>();
  return { config: { ...config, portal: { ...config.portal, url: 'https://ronin-agent.example.com', sessionSecret: 's'.repeat(40) } } };
});
vi.mock('../../platform/config/repos.js', () => ({
  loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x', portal: { name: 'Acme', apps: { backoffice: { name: 'Backoffice' } } } }],
}));

import type { Access } from '../access/access.js';

const { config } = await import('../../platform/config/config.js');
const { dashboardApp } = await import('../../apps/api/routes.js');
const { createRequest } = await import('./requests.js');

const ADMIN: Access = { admin: true, repos: [{ repo: 'acme/tienda', permission: 'admin' }] };
const MEMBER: Access = { admin: false, repos: [{ repo: 'otra/cosa', permission: 'triage' }] };
const call = (path: string, init: RequestInit = {}, access = ADMIN) =>
  dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });
const post = (path: string, body: unknown, access = ADMIN) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, access);

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
});

describe('the portal from the dashboard, in Hono', () => {
  it("leaves the portal's accounts to the admins, and takes changes only as JSON", async () => {
    expect((await call('/api/portal-admin', {}, MEMBER)).status).toBe(403);
    expect((await call('/api/portal-admin/users', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a' })).status).toBe(415);
    const bad = await call('/api/portal-admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'se espera JSON' });
  });

  it('creates an account with its invitation, sends it a new link, and edits it, saying what is wrong in words', async () => {
    const created = await post('/api/portal-admin/users', { email: 'persona@gmail.com', name: 'Ana', grants: [{ repo: 'acme/tienda', app: 'backoffice' }] });
    expect(created.status).toBe(200);
    const { user } = await created.json() as { user: { id: string; email: string } };
    expect(user.email).toBe('persona@gmail.com');
    expect(sendMail).toHaveBeenCalledOnce();
    expect((await post('/api/portal-admin/users', { email: 'persona@gmail.com', name: 'Ana', grants: [] })).status).toBe(400);
    expect((await post(`/api/portal-admin/users/${user.id}/link`, {})).status).toBe(200);
    expect((await post('/api/portal-admin/users/nadie/link', {})).status).toBe(404);
    const edited = await post(`/api/portal-admin/users/${user.id}`, { name: 'Ana Pérez' });
    expect(await edited.json()).toMatchObject({ user: { name: 'Ana Pérez' } });
    expect(await (await call('/api/portal-admin')).json()).toMatchObject({ enabled: true, users: [{ name: 'Ana Pérez', today: { used: 0 } }] });
  });

  it('shows only the requests of the repos the session sees', async () => {
    const created = await post('/api/portal-admin/users', { email: 'persona@gmail.com', name: 'Ana', grants: [] });
    const { user } = await created.json() as { user: { id: string } };
    const request = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'backoffice', text: 'Un cambio', images: [] });
    expect((await (await call('/api/pedidos')).json()).requests.map((r: { number: number }) => r.number)).toEqual([request.number]);
    expect((await call(`/api/pedidos/${request.number}`)).status).toBe(200);
    expect((await call(`/api/pedidos/${request.number}`, {}, MEMBER)).status).toBe(404);
    expect((await (await call('/api/pedidos', {}, MEMBER)).json()).requests).toEqual([]);
    expect((await call('/api/pedidos/abc')).status).toBe(404);
    expect((await call('/api/nada')).status).toBe(404);
  });
});
