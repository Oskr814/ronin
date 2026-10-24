import { describe, it, expect, vi } from 'vitest';
import type { Access } from '@domains/access/access.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@platform/config/repos.js', () => ({ loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x' }] }));
const RUN = { runId: 'r1', repo: 'acme/tienda', taskType: 'update-changelog', label: 'v1.2 (notas)', account: 'a', worktree: '/w', startedAt: new Date().toISOString(), state: 'ok', steps: 1 };
vi.mock('@domains/access/visible.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('@domains/access/visible.js')>()), visibleRuns: async () => [RUN] }));
vi.mock('@domains/items/github.js', () => ({ repoGithub: async () => ({ prs: [], issues: [] }), forgetGithub: () => {} }));
// The item and its PR's files, as GitHub would have them.
const ref = { kind: 'issue', number: 12 };
vi.mock('@domains/items/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@domains/items/service.js')>()),
  itemContext: async () => ({ entry: { productRepo: 'acme/tienda', productRepoPath: '/x' }, ref, gh: null, detail: {} }),
  filesContext: async () => ({ entry: { productRepo: 'acme/tienda', productRepoPath: '/x' }, prNumber: 13, files: { files: [] } }),
}));
const dropped = vi.fn(async (_n: number) => {});
vi.mock('@domains/portal/follow.js', () => ({ noteClosing: async () => 7, dropCloseNote: (n: number) => dropped(n) }));
vi.mock('@domains/items/new-issue.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('@domains/items/new-issue.js')>()), repoApps: async () => [] }));
vi.mock('@domains/items/actions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@domains/items/actions.js')>();
  return { ...original, runAction: async () => { throw new original.ActionError('Ese issue ya está cerrado.'); } };
});
vi.mock('@platform/github/github-as-user.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@platform/github/github-as-user.js')>();
  return { ...original, viewedFiles: async () => { throw new original.GithubUserError('Tu sesión de GitHub venció: vuelve a entrar.', true); }, pendingReview: async () => null };
});

const { dashboardApp } = await import('@apps/api/routes.js');

const ACCESS: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'push', perms: { notas: true, aprobar: true, acciones: true, desplegar: false } }] };
const call = (path: string, init: RequestInit = {}) => dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access: ACCESS, incoming: {} as never, outgoing: {} as never });

describe("the dashboard's items, in Hono", () => {
  it('finds an item that is only a run, by its id with colons and spaces', async () => {
    const id = 'acme/tienda:update-changelog:v1.2 (notas)';
    expect(await (await call(`/api/items/${encodeURIComponent(id)}`)).json()).toEqual({ id, runs: [RUN], commands: [] });
    expect((await call(`/api/items/${encodeURIComponent('acme/tienda:otra:cosa')}`)).status).toBe(404);
  });

  it("answers an action that doesn't fit with a 409, and takes back the reason kept for the portal", async () => {
    const res = await call(`/api/items/${encodeURIComponent('acme/tienda#12')}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'close-issue', text: 'Ya no hace falta' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Ese issue ya está cerrado.' });
    expect(dropped).toHaveBeenCalledWith(7);
    const bad = await call(`/api/items/${encodeURIComponent('acme/tienda#12')}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    expect(await bad.json()).toEqual({ error: 'falta la acción' });
  });

  it('asks to log in again when GitHub no longer takes the person’s token', async () => {
    const res = await call(`/api/items/${encodeURIComponent('acme/tienda#12')}/files/mine`);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/vuelve a entrar/);
  });
});
