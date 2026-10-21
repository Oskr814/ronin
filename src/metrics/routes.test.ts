import { describe, it, expect, vi } from 'vitest';
import type { Access } from '../server/api/access.js';

vi.mock('../core/repos.js', () => ({ loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x' }] }));
vi.mock('../server/api/dashboard-suscripcion.js', () => ({
  suscripcionView: async (_entries: unknown, account: string | null) => (account === 'nadie' ? null : { accounts: ['acme'], cuentas: [{ account: account ?? 'acme' }] }),
}));

const { dashboardApp } = await import('../apps/api/routes.js');

const ADMIN: Access = { admin: true, repos: [{ repo: 'acme/tienda', permission: 'admin' }] };
const MEMBER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage' }] };
const call = (path: string, access: Access) => dashboardApp.request(path, {}, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });

describe('the subscription in Métricas, in Hono', () => {
  it('is for admins only, by account', async () => {
    expect((await call('/api/metricas/suscripcion', MEMBER)).status).toBe(403);
    expect(await (await call('/api/metricas/suscripcion?cuenta=acme', ADMIN)).json()).toEqual({ accounts: ['acme'], cuentas: [{ account: 'acme' }] });
    const missing = await call('/api/metricas/suscripcion?cuenta=nadie', ADMIN);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('no hay una cuenta de Claude nadie');
  });
});
