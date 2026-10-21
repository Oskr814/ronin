import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Access } from '../../../src/domains/access/access.js';

vi.mock('../../../src/platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const launched = vi.fn(async (_n: number) => {});
vi.mock('../../../src/domains/meetings/launch.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/domains/meetings/launch.js')>()), launchMeetingWorker: (n: number) => launched(n) }));
vi.mock('../../../src/platform/config/repos.js', () => ({
  loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x' }, { productRepo: 'acme/otra', productRepoPath: '/y' }],
}));

const { config } = await import('../../../src/platform/config/config.js');
const { dashboardApp } = await import('../../../src/apps/api/routes.js');
const { updateMeeting } = await import('../../../src/domains/meetings/meetings.js');

const ALL = { notas: true, aprobar: true, acciones: true, desplegar: false };
const MEMBER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage', perms: ALL }] };
const READER: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage', perms: { ...ALL, notas: false, aprobar: false } }] };
const STRANGER: Access = { admin: false, repos: [{ repo: 'acme/otra', permission: 'triage' }] };
const call = (path: string, init: RequestInit = {}, access = MEMBER) =>
  dashboardApp.request(path, init, { session: { login: 'oskr814', token: 't' }, access, incoming: {} as never, outgoing: {} as never });
const post = (path: string, body: unknown, access = MEMBER) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, access);
const NOTES = { repo: 'acme/tienda', title: 'Planificación', text: 'Decidimos agregar el teléfono del cliente al pedido.' };

beforeEach(async () => {
  await rm(config.meetings.dataDir, { recursive: true, force: true });
  launched.mockClear();
});

describe('Reuniones from the dashboard, in Hono', () => {
  it('uploads pasted notes, starts reading them, and refuses the same notes twice', async () => {
    const res = await post('/api/reuniones', NOTES);
    expect(res.status).toBe(200);
    const row = await res.json() as { number: number; title: string };
    expect(row.title).toBe('Planificación');
    expect(launched).toHaveBeenCalledWith(row.number);
    const again = await post('/api/reuniones', NOTES);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ number: row.number });
  });

  it('says what is wrong with an upload, and who can not upload', async () => {
    expect((await call('/api/reuniones', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    const bad = await post('/api/reuniones', { repo: 'acme/tienda' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Sube un archivo o pega el texto/);
    expect((await post('/api/reuniones', NOTES, READER)).status).toBe(403);
    expect((await post('/api/reuniones', NOTES, STRANGER)).status).toBe(400);
  });

  it('shows a meeting only to who sees its repo, and its original only when it was a file', async () => {
    const { number } = await (await post('/api/reuniones', NOTES)).json() as { number: number };
    expect((await (await call('/api/reuniones')).json()).meetings.map((m: { number: number }) => m.number)).toEqual([number]);
    expect((await (await call('/api/reuniones', {}, STRANGER)).json()).meetings).toEqual([]);
    expect((await call(`/api/reuniones/${number}`)).status).toBe(200);
    expect((await call(`/api/reuniones/${number}`, {}, STRANGER)).status).toBe(404);
    const original = await call(`/api/reuniones/${number}/original`);
    expect(original.status).toBe(404);
    expect((await original.json()).error).toBe('esas notas se pegaron: no hay archivo');
  });

  it('retries only a failed reading, approves only one under review, and discards with the right permission', async () => {
    const { number } = await (await post('/api/reuniones', NOTES)).json() as { number: number };
    expect((await post(`/api/reuniones/${number}/reintentar`, {})).status).toBe(409);
    await updateMeeting(number, (m) => { m.status = 'failed'; });
    launched.mockClear();
    expect((await post(`/api/reuniones/${number}/reintentar`, {})).status).toBe(200);
    expect(launched).toHaveBeenCalledWith(number);
    const approve = await post(`/api/reuniones/${number}/aprobar`, { items: [] });
    expect(approve.status).toBe(409);
    expect((await approve.json()).error).toBe('Esa reunión no espera revisión.');
    expect((await post(`/api/reuniones/${number}/descartar`, {}, READER)).status).toBe(403);
    await updateMeeting(number, (m) => { m.status = 'review'; });
    expect(await (await post(`/api/reuniones/${number}/descartar`, {})).json()).toEqual({ status: 'discarded' });
  });
});
