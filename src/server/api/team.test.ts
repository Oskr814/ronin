import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-team-'));
const config = vi.hoisted(() => ({ settings: { dataDir: '' }, dashboard: { admins: [] as string[], allowedUsers: [] as string[] } }));
config.settings.dataDir = dir;
vi.mock('../../core/config.js', () => ({ config }));
vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sessionAccess = vi.fn();
vi.mock('./access.js', () => ({ sessionAccess: (...a: unknown[]) => sessionAccess(...a) }));

const { applyTeam, can, entradaOf, permsFor, teamAccess } = await import('./team.js');

const SC = 'redmotos/shoppingcart';
const BM = 'Bmedical/bmedical';
const write = (team: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'people.json'), JSON.stringify(team));
};

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.DASHBOARD_ADMINS = 'jefa';
  delete process.env.DASHBOARD_ALLOWED_USERS;
  sessionAccess.mockReset();
});

describe('permsFor', () => {
  it('gives a member without a choice everything but deploying, as before', () => {
    expect(permsFor({ people: {} }, 'ana', SC)).toEqual({ notas: true, aprobar: true, acciones: true, desplegar: false });
  });

  it('follows the repo\'s set, the default set, their own choice and the deploy grant', () => {
    const team = { porDefecto: 'lectura' as const, people: { ana: { repos: { [SC]: { set: 'reuniones' as const, desplegar: true }, [BM]: { custom: { notas: false, aprobar: true, acciones: true } } } } } };
    expect(permsFor(team, 'ana', SC)).toEqual({ notas: true, aprobar: true, acciones: false, desplegar: true });
    expect(permsFor(team, 'ana', BM)).toEqual({ notas: false, aprobar: true, acciones: true, desplegar: false });
    expect(permsFor(team, 'luis', SC)).toEqual({ notas: false, aprobar: false, acciones: false, desplegar: false });
  });

  it('lets an admin do everything, from .env or from the team', () => {
    const team = { porDefecto: 'lectura' as const, people: { luis: { role: 'admin' as const } } };
    expect(permsFor(team, 'jefa', SC).desplegar).toBe(true);
    expect(permsFor(team, 'luis', SC)).toEqual({ notas: true, aprobar: true, acciones: true, desplegar: true });
  });
});

describe('applyTeam', () => {
  it('makes admins of .env\'s and the team\'s, and keeps the door as .env says until changed', () => {
    const target = { admins: [] as string[], allowedUsers: [] as string[] };
    process.env.DASHBOARD_ALLOWED_USERS = 'ana';
    const team = { people: { luis: { role: 'admin' as const }, marta: {} } };
    expect(entradaOf(team)).toBe('lista');
    applyTeam(team, target);
    expect(target.admins).toEqual(['jefa', 'luis']);
    expect(target.allowedUsers).toEqual(['ana', 'luis', 'marta']);
    applyTeam({ ...team, entrada: 'github' }, target);
    expect(target.allowedUsers).toEqual([]);
  });
});

describe('teamAccess', () => {
  it('takes out the repos an admin hid and works out the rest\'s permissions', async () => {
    write({ people: { ana: { repos: { [BM]: { hidden: true }, [SC]: { set: 'lectura' } } } } });
    sessionAccess.mockResolvedValue({ admin: false, repos: [{ repo: SC, permission: 'push' }, { repo: BM, permission: 'push' }] });
    const access = await teamAccess({ login: 'ana', token: 't' }, []);
    expect(access.repos).toEqual([{ repo: SC, permission: 'push', perms: { notas: false, aprobar: false, acciones: false, desplegar: false } }]);
    expect(can(access, SC, 'acciones')).toBe(false);
    expect(can(access, BM, 'notas')).toBe(false);
    expect(sessionAccess.mock.calls[0][2]).toEqual(['jefa']);
  });

  it('asks GitHub with the team\'s admins too', async () => {
    write({ people: { luis: { role: 'admin' } } });
    sessionAccess.mockResolvedValue({ admin: true, repos: [{ repo: SC, permission: 'admin-del-tablero' }] });
    const access = await teamAccess({ login: 'luis', token: 't' }, []);
    expect(sessionAccess.mock.calls[0][2]).toEqual(['jefa', 'luis']);
    expect(can(access, SC, 'desplegar')).toBe(true);
  });
});

describe('can', () => {
  it('keeps the old rule without permissions worked out: everything but deploying', () => {
    const access = { admin: false, repos: [{ repo: SC, permission: 'triage' as const }] };
    expect(can(access, SC, 'acciones')).toBe(true);
    expect(can(access, SC, 'desplegar')).toBe(false);
    expect(can(access, BM, 'notas')).toBe(false);
  });
});
