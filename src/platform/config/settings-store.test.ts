import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDb, type Db } from '../db/db.js';
import { TEST_DATABASE_URL, testDb } from '../db/testing.js';
import { appendSettingsLog, readSettingsLog, readSettings, updateSettings } from './settings-store.js';

const dir = mkdtempSync(join(tmpdir(), 'ronin-settings-store-'));
const entry = (n: number) => ({ at: new Date(Date.UTC(2026, 9, 20, 10, n)).toISOString(), login: 'persona', what: `General · cosa ${n}`, from: String(n), to: String(n + 1) });

// The same behavior, whichever keeps them.
function behaves(name: string, setup: () => Promise<void>) {
  describe(name, () => {
    beforeEach(setup);

    it('reads nothing changed at first, then what was saved, and forgets what was taken out', async () => {
      expect(await readSettings(dir)).toEqual({ values: {} });
      await updateSettings(dir, 'persona', (file) => {
        file.values['portal.dailyLimit'] = 7;
        file.values['explore.timezone'] = 'America/Tegucigalpa';
        file.values['preview.prepareData'] = false;
        file.tasks = { 'fix-issue': { model: 'sonnet' }, 'spike': { effort: 'low' } };
        file.accounts = { bmedical: { plan: 'pro' } };
      });
      expect(await readSettings(dir)).toEqual({
        values: { 'portal.dailyLimit': 7, 'explore.timezone': 'America/Tegucigalpa', 'preview.prepareData': false },
        tasks: { 'fix-issue': { model: 'sonnet' }, 'spike': { effort: 'low' } },
        accounts: { bmedical: { plan: 'pro' } },
      });
      await updateSettings(dir, 'persona', (file) => {
        delete file.values['portal.dailyLimit'];
        file.tasks = { 'fix-issue': { model: 'haiku', effort: 'high' } };
        file.accounts = {};
      });
      const after = await readSettings(dir);
      expect(after.values).toEqual({ 'explore.timezone': 'America/Tegucigalpa', 'preview.prepareData': false });
      expect(after.tasks).toEqual({ 'fix-issue': { model: 'haiku', effort: 'high' } });
      expect(after.accounts ?? {}).toEqual({});
    });

    it('changes nothing when the change throws', async () => {
      await updateSettings(dir, 'persona', (file) => { file.values['portal.dailyLimit'] = 7; });
      await expect(updateSettings(dir, 'persona', (file) => {
        file.values['portal.dailyLimit'] = 9;
        throw new Error('no');
      })).rejects.toThrow('no');
      expect((await readSettings(dir)).values['portal.dailyLimit']).toBe(7);
    });

    it('takes changes one at a time, so none is lost', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, i) => updateSettings(dir, 'persona', (file) => { file.values[`k${i}`] = i; })));
      expect(Object.keys((await readSettings(dir)).values).sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    });

    it('keeps the record of changes, newest first and up to a limit', async () => {
      expect(await readSettingsLog(dir)).toEqual([]);
      for (const n of [1, 2, 3]) await appendSettingsLog(dir, entry(n));
      expect(await readSettingsLog(dir)).toEqual([entry(3), entry(2), entry(1)]);
      expect(await readSettingsLog(dir, 2)).toEqual([entry(3), entry(2)]);
    });
  });
}

behaves('settings-store, in files (without DATABASE_URL)', async () => {
  setDb(null);
  rmSync(dir, { recursive: true, force: true });
});

it('in files, keeps them where they always were', async () => {
  setDb(null);
  rmSync(dir, { recursive: true, force: true });
  await updateSettings(dir, 'persona', (file) => { file.values['portal.dailyLimit'] = 7; });
  await appendSettingsLog(dir, entry(1));
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ values: { 'portal.dailyLimit': 7 } });
  expect(readFileSync(join(dir, 'registro.jsonl'), 'utf8').trim()).toBe(JSON.stringify(entry(1)));
});

describe.skipIf(!TEST_DATABASE_URL)('with Postgres', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });

  behaves('settings-store, in Postgres', async () => {
    setDb(db);
    for (const table of ['settings', 'task_settings', 'claude_account_plans', 'settings_log'] as const) await db.deleteFrom(table).execute();
  });

  it('says who changed each one, and touches only what changed', async () => {
    setDb(db);
    await updateSettings(dir, 'una', (file) => { file.values.a = 1; file.values.b = 2; });
    await updateSettings(dir, 'otra', (file) => { file.values.b = 3; });
    const rows = await db.selectFrom('settings').select(['key', 'updated_by']).orderBy('key').execute();
    expect(rows).toEqual([{ key: 'a', updated_by: 'una' }, { key: 'b', updated_by: 'otra' }]);
  });

  it('reads nothing changed, without stopping, when the database does not answer', async () => {
    const { createDb } = await import('../db/db.js');
    setDb(createDb('postgres://nadie:nada@127.0.0.1:1/ninguna'));
    expect(await readSettings(dir)).toEqual({ values: {} });
    setDb(db);
  });
});
