import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-ajustes-'));
const config = vi.hoisted(() => ({
  settings: { dataDir: '' },
  notifyTo: 'jefa@x.com',
  dashboard: { sessionDays: 7, githubTtlSeconds: 60, url: 'https://tablero' },
  portal: { dailyLimit: 5, sessionDays: 30, url: 'https://portal' },
}));
config.settings.dataDir = dir;
vi.mock('../../core/config.js', () => ({ config }));
vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const teamPeople = vi.fn();
vi.mock('../../core/linear-api.js', () => ({ linearKey: (entry: { linear?: unknown }) => (entry.linear ? 'lin_key' : null), teamPeople: (...a: unknown[]) => teamPeople(...a) }));

const { AjustesError, ajustesView, linearTeams, readRegistro, saveNotificacion, saveProfile, setValue } = await import('./ajustes.js');

const SC = { productRepo: 'redmotos/shoppingcart', productRepoPath: '/tmp/sc', linear: { apiKeyEnv: 'LINEAR_API_KEY_X' } };
const BM = { productRepo: 'Bmedical/bmedical', productRepoPath: '/tmp/bm' };

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  config.portal.dailyLimit = 5;
  delete process.env.PORTAL_DAILY_LIMIT;
  teamPeople.mockResolvedValue({ team: 'RED', workspace: 'red-motos', people: [{ id: 'u1', name: 'Ana Rivera' }, { id: 'u2', name: 'Luis Castro' }] });
});

describe('setValue', () => {
  it('saves a value, applies it to config right away and records it', async () => {
    process.env.PORTAL_DAILY_LIMIT = '5';
    const out = await setValue('admin1', { key: 'portal.dailyLimit', value: 8 }) as { setting: { value: number; source: string } };
    expect(out.setting).toMatchObject({ value: 8, source: 'tablero' });
    expect(config.portal.dailyLimit).toBe(8);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ values: { 'portal.dailyLimit': 8 } });
    expect(await readRegistro()).toEqual([expect.objectContaining({ login: 'admin1', what: 'General · portal.dailyLimit', from: '5 (.env)', to: '8' })]);
  });

  it('goes back to .env\'s with null, and records that too', async () => {
    process.env.PORTAL_DAILY_LIMIT = '5';
    await setValue('admin1', { key: 'portal.dailyLimit', value: 8 });
    await setValue('admin1', { key: 'portal.dailyLimit', value: null });
    expect(config.portal.dailyLimit).toBe(5);
    const [last] = await readRegistro();
    expect(last).toMatchObject({ from: '8', to: '5 (.env)' });
  });

  it('refuses an unknown setting or a value out of range, and saves nothing', async () => {
    await expect(setValue('admin1', { key: 'DASHBOARD_SESSION_SECRET', value: 1 })).rejects.toBeInstanceOf(AjustesError);
    await expect(setValue('admin1', { key: 'portal.dailyLimit', value: 500 })).rejects.toThrow(/entre 0 y 100/);
    expect(await readRegistro()).toEqual([]);
  });

  it('records nothing when the value didn\'t change', async () => {
    await setValue('admin1', { key: 'portal.dailyLimit', value: 8 });
    await setValue('admin1', { key: 'portal.dailyLimit', value: 8 });
    expect(await readRegistro()).toHaveLength(1);
  });
});

describe('saveProfile', () => {
  it('saves the person\'s name, email and who they are in Linear', async () => {
    const teams = await linearTeams([SC, BM]);
    expect(teams).toEqual([expect.objectContaining({ repo: SC.productRepo, team: 'RED' })]);
    await saveProfile('ana-dev', { name: ' Ana Rivera ', email: 'Persona@Gmail.com', linear: { repo: SC.productRepo, id: 'u1' } }, teams);
    const view = await ajustesView('ana-dev', false, [SC]) as { perfil: unknown; general?: unknown };
    expect(view.perfil).toEqual({ name: 'Ana Rivera', email: 'persona@gmail.com', linear: { [SC.productRepo]: { id: 'u1', name: 'Ana Rivera' } } });
    expect(view.general).toBeUndefined();
    expect((await readRegistro()).map((e) => e.what)).toEqual([`Perfil · Linear de ${SC.productRepo}`, 'Perfil · correo', 'Perfil · nombre']);
  });

  it('refuses a bad email, or someone who isn\'t in the team', async () => {
    const teams = await linearTeams([SC]);
    await expect(saveProfile('ana-dev', { email: 'no-es-correo' }, teams)).rejects.toThrow(/correo/);
    await expect(saveProfile('ana-dev', { linear: { repo: SC.productRepo, id: 'u9' } }, teams)).rejects.toThrow(/equipo de Linear/);
    await expect(saveProfile('ana-dev', { linear: { repo: BM.productRepo, id: 'u1' } }, teams)).rejects.toThrow(/no tiene Linear/);
  });

  it('clears a field with an empty string', async () => {
    await saveProfile('ana-dev', { email: 'persona@gmail.com' }, []);
    await saveProfile('ana-dev', { email: '' }, []);
    expect((await ajustesView('ana-dev', false, [])) as { perfil: unknown }).toMatchObject({ perfil: {} });
  });
});

describe('ajustesView', () => {
  it('gives an admin the settings of General, with where each comes from', async () => {
    await setValue('admin1', { key: 'dashboard.sessionDays', value: 14 });
    const view = await ajustesView('admin1', true, []) as { general: Array<{ key: string; source: string; value: number }> };
    expect(view.general.find((s) => s.key === 'dashboard.sessionDays')).toMatchObject({ value: 14, source: 'tablero' });
    expect(view.general.find((s) => s.key === 'portal.dailyLimit')).toMatchObject({ value: 5, source: 'defecto' });
  });
});

describe('saveNotificacion', () => {
  it('saves the person\'s choice in a repo they see, starting from their defaults, and records it', async () => {
    const sc = { ...SC, portal: { name: 'Red Motos', apps: {}, notifyTo: ['persona@gmail.com'] } };
    await saveProfile('ana-dev', { email: 'persona@gmail.com' }, []);
    let view = await ajustesView('ana-dev', false, [sc]) as { notificaciones: Array<{ events: string[]; chosen: boolean }> };
    expect(view.notificaciones[0]).toMatchObject({ events: ['pedido-equipo', 'pedido-revisar', 'reunion'], chosen: false });
    const out = await saveNotificacion('ana-dev', { repo: sc.productRepo, event: 'reunion', on: false }, [sc]) as typeof view;
    expect(out.notificaciones[0]).toMatchObject({ events: ['pedido-equipo', 'pedido-revisar'], chosen: true });
    await expect(saveNotificacion('ana-dev', { repo: BM.productRepo, event: 'bloqueo', on: true }, [sc])).rejects.toThrow(/no está entre los que ves/);
    await expect(saveNotificacion('ana-dev', { repo: sc.productRepo, event: 'todo', on: true }, [sc])).rejects.toThrow(/no existe/);
    expect((await readRegistro())[0]).toMatchObject({ what: `Notificaciones · ${sc.productRepo} · propuestas de una reunión`, from: 'sí', to: 'no' });
  });
});
