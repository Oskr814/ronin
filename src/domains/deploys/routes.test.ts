import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Access } from '../access/access.js';

vi.mock('../../platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../platform/config/repos.js', () => ({
  loadRepos: async () => [
    { productRepo: 'acme/tienda', productRepoPath: '/x', deploy: { workflow: 'deploy.yml' } },
    { productRepo: 'acme/docs', productRepoPath: '/y' },
  ],
}));
// GitHub's side of a release, out of the way.
const plan = vi.fn();
const publish = vi.fn();
vi.mock('./board.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./board.js')>()),
  despliegues: async (entries: Array<{ productRepo: string; deploy?: unknown }>) => entries.filter((e) => e.deploy).map((e) => ({ repo: e.productRepo })),
  planDespliegue: (...args: unknown[]) => plan(...args),
  publishDespliegue: (...args: unknown[]) => publish(...args),
}));

const { dashboardApp } = await import('../../apps/api/routes.js');
const { DespliegueError } = await import('./board.js');

const DEPLOYER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'push', perms: { notas: true, aprobar: true, acciones: true, desplegar: true } }, { repo: 'acme/docs', permission: 'push', perms: { notas: true, aprobar: true, acciones: true, desplegar: true } }] };
const call = (path: string, init: RequestInit = {}, access = DEPLOYER) =>
  dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });
const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  plan.mockReset();
  publish.mockReset();
});

describe('Despliegues from the dashboard, in Hono', () => {
  it('lists the repos it can deploy', async () => {
    expect(await (await call('/api/despliegues')).json()).toEqual({ repos: [{ repo: 'acme/tienda' }] });
  });

  it('plans a release with the body checked, and says why it can not', async () => {
    plan.mockResolvedValue({ tag: 'v1.2.0', prs: [] });
    const res = await post('/api/despliegues/acme/tienda/plan', { tag: 'v1.2.0', prs: 'all' });
    expect(await res.json()).toEqual({ tag: 'v1.2.0', prs: [] });
    expect(plan.mock.calls[0][1]).toMatchObject({ tag: 'v1.2.0', prs: 'all' });
    expect((await (await post('/api/despliegues/acme/tienda/plan', { prs: 'all' })).json()).error).toBe('falta el tag');
    expect((await call('/api/despliegues/acme/tienda/plan', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await post('/api/despliegues/acme/docs/plan', { tag: 'v1', prs: 'all' })).status).toBe(404);
  });

  it('publishes it, or answers with the plan as it is now when it changed', async () => {
    publish.mockResolvedValue({ tag: 'v1.2.0', url: 'https://github.com/acme/tienda/releases/tag/v1.2.0' });
    expect(await (await post('/api/despliegues/acme/tienda/publish', { tag: 'v1.2.0', prs: [12] })).json()).toMatchObject({ tag: 'v1.2.0' });
    expect(publish.mock.calls[0][2]).toBe('oskr814');
    publish.mockRejectedValue(new DespliegueError('El plan cambió: revísalo de nuevo.', 409, { tag: 'v1.2.0', prs: [12, 13] }));
    const changed = await post('/api/despliegues/acme/tienda/publish', { tag: 'v1.2.0', prs: [12] });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'El plan cambió: revísalo de nuevo.', plan: { tag: 'v1.2.0', prs: [12, 13] } });
  });
});
