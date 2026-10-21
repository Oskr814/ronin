import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-notif-'));
const config = vi.hoisted(() => ({ settings: { dataDir: '' }, notifyTo: 'jefa@x.com' }));
config.settings.dataDir = dir;
vi.mock('../config/config.js', () => ({ config }));
vi.mock('../logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const { defaultEvents, recipientsFor } = await import('./notifications.js');

const SC = 'redmotos/shoppingcart';
const entry = { portal: { name: 'Red Motos', apps: {}, notifyTo: ['ana@x.com', 'externo@x.com'] } };
const people = (p: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'people.json'), JSON.stringify({ people: p }));
};

beforeEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recipientsFor', () => {
  it('works as before while nobody chose: portal.notifyTo, and NOTIFY_TO for blockers', async () => {
    expect(await recipientsFor(SC, entry, 'pedido-equipo')).toBe('ana@x.com, externo@x.com');
    expect(await recipientsFor(SC, entry, 'reunion')).toBe('ana@x.com, externo@x.com');
    expect(await recipientsFor(SC, entry, 'bloqueo')).toBe('jefa@x.com');
    expect(await recipientsFor(SC, undefined, 'pedido-revisar')).toBe('jefa@x.com');
  });

  it('counts a person whose email was on the list as subscribed, until they choose', async () => {
    people({ ana: { email: 'ana@x.com' }, jefa: { email: 'Jefa@x.com' } });
    expect(defaultEvents('ana@x.com', entry)).toEqual(['pedido-equipo', 'pedido-revisar', 'reunion']);
    expect(defaultEvents('jefa@x.com', entry)).toEqual(['bloqueo']);
    expect(await recipientsFor(SC, entry, 'pedido-equipo')).toBe('ana@x.com, externo@x.com');
  });

  it('follows what each one chose, and keeps the old addresses that are nobody\'s', async () => {
    people({ ana: { email: 'ana@x.com', notify: { [SC]: ['bloqueo'] } }, luis: { email: 'luis@x.com', notify: { [SC]: ['pedido-equipo', 'bloqueo'] } } });
    expect(await recipientsFor(SC, entry, 'pedido-equipo')).toBe('luis@x.com, externo@x.com');
    expect(await recipientsFor(SC, entry, 'bloqueo')).toBe('ana@x.com, luis@x.com, jefa@x.com');
    expect(await recipientsFor('Bmedical/bmedical', undefined, 'pedido-equipo')).toBe('jefa@x.com');
  });

  it('falls back to NOTIFY_TO when nobody gets it', async () => {
    people({ ana: { email: 'ana@x.com', notify: { [SC]: [] } }, jefa: { email: 'jefa@x.com', notify: { [SC]: [] } } });
    expect(await recipientsFor(SC, { portal: { name: 'x', apps: {}, notifyTo: ['ana@x.com'] } }, 'pedido-equipo')).toBe('jefa@x.com');
    expect(await recipientsFor(SC, entry, 'bloqueo')).toBe('jefa@x.com');
  });
});
