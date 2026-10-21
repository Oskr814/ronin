import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-usuarios-'));
const config = vi.hoisted(() => ({ settings: { dataDir: '' }, githubToken: 'ronin', dashboard: { admins: [] as string[], allowedUsers: [] as string[] } }));
config.settings.dataDir = dir;
vi.mock('@platform/config/config.js', () => ({ config, taskEnvModel: () => undefined, taskEnvEffort: () => undefined, taskDefaultModel: (t: string) => (t === 'update-changelog' ? 'haiku' : undefined) }));
vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const { readSettingsLog } = await import('./settings.js');
const { addUser, removeUser, updateTeamDefaults, updateUser, userView, usersView } = await import('./users.js');

const SC = 'redmotos/shoppingcart';
const BM = 'Bmedical/bmedical';
const ENTRIES = [{ productRepo: SC, productRepoPath: '/sc' }, { productRepo: BM, productRepoPath: '/bm' }];
// GitHub: ana can push to shoppingcart only; ghost doesn't exist.
const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.endsWith('/users/ghost')) return new Response('', { status: 404 });
  if (u.includes('/users/')) return new Response('{}', { status: 200 });
  const m = /repos\/(.+)\/collaborators\/(.+)\/permission/.exec(u);
  if (m && m[1] === SC && m[2] !== 'nadie') return new Response(JSON.stringify({ permission: 'write', role_name: 'write' }), { status: 200 });
  return new Response('', { status: 404 });
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASHBOARD_ADMINS = 'jefa';
  delete process.env.DASHBOARD_ALLOWED_USERS;
  config.dashboard.admins.splice(0);
  config.dashboard.allowedUsers.splice(0);
  vi.stubGlobal('fetch', fetchMock);
});

describe('addUser', () => {
  it('adds someone GitHub knows, records it, and refuses twice or a stranger', async () => {
    await addUser('jefa', { login: '@Ana', role: 'member' });
    await expect(addUser('jefa', { login: 'ana' })).rejects.toThrow(/ya está/);
    await expect(addUser('jefa', { login: 'ghost' })).rejects.toThrow(/no conoce/);
    await expect(addUser('jefa', { login: 'no válido' })).rejects.toThrow(/login/);
    const view = await usersView(ENTRIES) as { people: Array<{ login: string; role: string; addedBy?: string; repos: Array<{ repo: string; github: string | null }> }> };
    expect(view.people.map((p) => p.login)).toEqual(['ana', 'jefa']);
    expect(view.people[0]).toMatchObject({ role: 'member', addedBy: 'jefa', repos: [{ repo: SC, github: 'write' }, { repo: BM, github: null }] });
    expect((await readSettingsLog())[0]).toMatchObject({ login: 'jefa', what: 'Usuarios · @ana', to: 'agregado como miembro' });
  });
});

describe('updateUser', () => {
  it('makes an admin, who then gets in as one', async () => {
    await addUser('jefa', { login: 'ana' });
    await updateUser('jefa', 'ana', { role: 'admin' }, ENTRIES);
    expect(config.dashboard.admins).toEqual(['jefa', 'ana']);
  });

  it('never touches an admin of .env, nor lets one demote themselves', async () => {
    await expect(updateUser('luis', 'jefa', { role: 'member' }, ENTRIES)).rejects.toThrow(/DASHBOARD_ADMINS/);
    await addUser('jefa', { login: 'luis', role: 'admin' });
    await expect(updateUser('luis', 'luis', { role: 'member' }, ENTRIES)).rejects.toThrow(/a ti mismo/);
  });

  it('sets a repo\'s permissions: a set, their own choice (back to a set when it is one), deploying, hidden', async () => {
    await addUser('jefa', { login: 'ana' });
    let view = await updateUser('jefa', 'ana', { repo: { repo: SC, set: 'reuniones' } }, ENTRIES) as { repos: Array<{ repo: string; set: string | null; perms: Record<string, boolean>; hidden: boolean }> };
    expect(view.repos[0]).toMatchObject({ set: 'reuniones', perms: { notas: true, aprobar: true, acciones: false, desplegar: false } });
    view = await updateUser('jefa', 'ana', { repo: { repo: SC, custom: { notas: false, aprobar: true, acciones: true } } }, ENTRIES) as typeof view;
    expect(view.repos[0].set).toBe('custom');
    view = await updateUser('jefa', 'ana', { repo: { repo: SC, custom: { notas: false, aprobar: false, acciones: false } } }, ENTRIES) as typeof view;
    expect(view.repos[0].set).toBe('lectura');
    view = await updateUser('jefa', 'ana', { repo: { repo: SC, desplegar: true, hidden: true } }, ENTRIES) as typeof view;
    expect(view.repos[0]).toMatchObject({ hidden: true, perms: { desplegar: true } });
    await expect(updateUser('jefa', 'ana', { repo: { repo: 'otro/repo', set: 'todo' } }, ENTRIES)).rejects.toThrow(/repos.json/);
    const whats = (await readSettingsLog()).map((e) => `${e.what}: ${e.from} → ${e.to}`);
    expect(whats[0]).toBe(`@ana · ${SC}: Solo lectura → oculto + desplegar`);
    expect(whats).toContain(`@ana · ${SC}: Por defecto (Todo) → Reuniones y pedidos`);
  });

  it('corrects their name and email', async () => {
    await addUser('jefa', { login: 'ana' });
    await updateUser('jefa', 'ana', { name: 'Ana Rivera', email: 'Persona@Gmail.com' }, ENTRIES);
    expect(await userView('ana', ENTRIES)).toMatchObject({ name: 'Ana Rivera', email: 'persona@gmail.com' });
    await expect(updateUser('jefa', 'ana', { email: 'nada' }, ENTRIES)).rejects.toThrow(/correo/);
  });
});

describe('removeUser', () => {
  it('takes someone off, but never an admin of .env nor oneself', async () => {
    await addUser('jefa', { login: 'ana' });
    await removeUser('jefa', 'ana');
    expect(await userView('ana', ENTRIES)).toBeNull();
    await expect(removeUser('luis', 'jefa')).rejects.toThrow(/DASHBOARD_ADMINS/);
    await addUser('jefa', { login: 'luis', role: 'admin' });
    await expect(removeUser('luis', 'luis')).rejects.toThrow(/a ti mismo/);
  });
});

describe('updateTeamDefaults', () => {
  it('closes the door to the list, and sets the default set', async () => {
    await addUser('jefa', { login: 'ana' });
    expect(await updateTeamDefaults('jefa', { entrada: 'lista', porDefecto: 'lectura' })).toEqual({ entrada: 'lista', porDefecto: 'lectura' });
    expect(config.dashboard.allowedUsers).toEqual(['ana']);
    await expect(updateTeamDefaults('jefa', { porDefecto: 'dios' })).rejects.toThrow(/no existe/);
    expect((await readSettingsLog()).map((e) => e.what)).toEqual(['Usuarios · Permisos por defecto', 'Usuarios · Entrada', 'Usuarios · @ana']);
  });
});
