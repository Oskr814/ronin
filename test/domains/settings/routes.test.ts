import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Access } from '../../../src/domains/access/access.js';

vi.mock('../../../src/platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/platform/config/repos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/platform/config/repos.js')>()),
  loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x' }],
}));

const { config } = await import('../../../src/platform/config/config.js');
const { dashboardApp } = await import('../../../src/apps/api/routes.js');

const ADMIN: Access = { admin: true, repos: [{ repo: 'acme/tienda', permission: 'admin' }] };
const MEMBER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage' }] };
const call = (path: string, init: RequestInit = {}, access = ADMIN) =>
  dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });
const post = (path: string, body: unknown, access = ADMIN) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, access);

beforeEach(async () => {
  await rm(config.settings.dataDir, { recursive: true, force: true });
});

describe('Ajustes from the dashboard, in Hono', () => {
  it('gives everyone their profile, and the rest only to admins', async () => {
    expect((await call('/api/settings', {}, MEMBER)).status).toBe(200);
    for (const [path, refusal] of [
      ['/api/settings/log', 'solo los administradores ven el registro'],
      ['/api/settings/connections', 'solo los administradores ven las conexiones'],
      ['/api/settings/repos', 'solo los administradores cambian los repos'],
      ['/api/settings/accounts', 'solo los administradores ven las cuentas de Claude'],
      ['/api/settings/users', 'solo los administradores manejan los usuarios'],
    ]) {
      const res = await call(path, {}, MEMBER);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error, path).toBe(refusal);
    }
    expect((await post('/api/settings/values', { key: 'portal.dailyLimit', value: 50 }, MEMBER)).status).toBe(403);
    expect((await post('/api/settings/users/alguien/remove', {}, MEMBER)).status).toBe(403);
  });

  it('takes changes only as JSON, and a body that is one', async () => {
    expect((await call('/api/settings/values', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await call('/api/settings/users/alguien/remove', { method: 'POST' })).status).toBe(415);
    const bad = await call('/api/settings/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1]' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('el pedido no llegó bien');
  });

  it('changes a setting, and the change is in the record', async () => {
    expect((await post('/api/settings/values', { key: 'portal.dailyLimit', value: 50 })).status).toBe(200);
    const { registro } = await (await call('/api/settings/log')).json() as { registro: Array<{ login: string; to: string }> };
    expect(registro[0]).toMatchObject({ login: 'oskr814', to: '50' });
  });

  it("says what's wrong in the service's words, with its status", async () => {
    const missing = await call('/api/settings/users/nadie');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('esa persona no está en la lista');
    const bad = await post('/api/settings/users', { login: 'no es un login' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Ese no es un login de GitHub.');
  });
});
