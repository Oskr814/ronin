import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Access } from '../server/api/access.js';

vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../core/repos.js', () => ({
  loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x', explore: ['web'] }, { productRepo: 'acme/otra', productRepoPath: '/y', explore: ['web'] }],
}));
vi.mock('../server/api/dashboard-github.js', () => ({ repoGithub: async () => ({ prs: [] }) }));
// A plain function, not vi.fn: its spy left the rejected promise of a
// failed launch unhandled.
const explored: unknown[][] = [];
let exploreNow: (...args: unknown[]) => Promise<unknown> = async () => ({});
vi.mock('../server/api/dashboard-exploraciones.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/api/dashboard-exploraciones.js')>()),
  liveRuns: async () => new Map(),
  exploracionList: async (entries: Array<{ productRepo: string }>) => entries.map((e) => ({ repo: e.productRepo, app: 'web' })),
  corridasOf: async () => [{ id: 'r1' }],
  inventarioOf: async (_e: unknown, app: string) => ({ app, functions: [] }),
  exploreNow: (...args: unknown[]) => {
    explored.push(args);
    return exploreNow(...args);
  },
}));

const { dashboardApp } = await import('../server/dashboard-app.js');
const { ExploreNowError } = await import('../server/api/dashboard-exploraciones.js');

const PERMS = { notas: true, aprobar: true, acciones: true, desplegar: false };
const MEMBER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'push', perms: PERMS }] };
const READER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage', perms: { ...PERMS, acciones: false } }] };
const call = (path: string, init: RequestInit = {}, access = MEMBER) =>
  dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });
const run = (path: string, body: unknown, access = MEMBER) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, access);

beforeEach(() => {
  explored.length = 0;
});

describe('Exploraciones from the dashboard, in Hono', () => {
  it('lists only the apps of the repos it sees, and an app only of a repo that explores it', async () => {
    expect(await (await call('/api/exploraciones')).json()).toEqual({ apps: [{ repo: 'acme/tienda', app: 'web' }] });
    expect(await (await call('/api/exploraciones/acme/tienda/web/corridas')).json()).toEqual({ corridas: [{ id: 'r1' }] });
    expect(await (await call('/api/exploraciones/acme/tienda/web/inventario')).json()).toEqual({ app: 'web', functions: [] });
    expect((await call('/api/exploraciones/acme/tienda/admin/corridas')).status).toBe(404);
    expect((await call('/api/exploraciones/acme/otra/web/inventario')).status).toBe(404);
  });

  it('explores now as whoever is logged in, with the permission for actions', async () => {
    exploreNow = async () => ({ started: true });
    expect(await (await run('/api/exploraciones/acme/tienda/web/run', { maxFunctions: 3 })).json()).toEqual({ started: true });
    expect(explored[0].slice(1, 3)).toEqual(['web', 'oskr814']);
    expect((await run('/api/exploraciones/acme/tienda/web/run', {}, READER)).status).toBe(403);
    expect((await call('/api/exploraciones/acme/tienda/web/run', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    exploreNow = async () => {
      throw new ExploreNowError('Ya hay una exploración de web corriendo.', 409);
    };
    const busy = await run('/api/exploraciones/acme/tienda/web/run', {});
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Ya hay una exploración de web corriendo.' });
  });
});
