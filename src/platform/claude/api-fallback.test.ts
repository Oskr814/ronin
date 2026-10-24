import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-api-fallback-'));
vi.mock('../config/config.js', () => ({ config: { settings: { dataDir: dir } } }));

const { setDb } = await import('../db/db.js');
const { TEST_DATABASE_URL, testDb } = await import('../db/testing.js');
const { addApiSpend, apiFallbackFor, MIN_LEFT_USD, readApiBudget, resetApiSpend } = await import('./api-fallback.js');

const repo = (maxUsd: number) => ({ productRepo: 'acme/app', apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY_ACME', model: 'sonnet', maxUsd } });
const env = { ANTHROPIC_API_KEY_ACME: 'sk-acme' };

// The same behavior, whichever keeps the counter.
function behaves(name: string, setup: () => Promise<void>) {
  describe(name, () => {
    beforeEach(setup);

    it('adds up what each run spent, and starts from zero when reset', async () => {
      expect(await readApiBudget('acme/app')).toEqual({ spentUsd: 0 });
      await addApiSpend('acme/app', 1.25);
      await addApiSpend('acme/app', 0.5);
      await addApiSpend('acme/app', 0);
      await addApiSpend('otro/repo', 9);
      expect((await readApiBudget('acme/app')).spentUsd).toBeCloseTo(1.75);

      await resetApiSpend('acme/app', 'persona', new Date('2026-10-24T12:00:00Z'));
      expect(await readApiBudget('acme/app')).toEqual({ spentUsd: 0, resetAt: '2026-10-24T12:00:00.000Z', resetBy: 'persona' });
      await addApiSpend('acme/app', 2);
      expect(await readApiBudget('acme/app')).toMatchObject({ spentUsd: 2, resetAt: '2026-10-24T12:00:00.000Z' });
      expect((await readApiBudget('otro/repo')).spentUsd).toBe(9);
    });

    it('offers the fallback while the repo has its key and money left', async () => {
      expect(await apiFallbackFor(repo(10), env)).toEqual({ apiKey: 'sk-acme', model: 'sonnet', leftUsd: 10 });
      await addApiSpend('acme/app', 4);
      expect(await apiFallbackFor(repo(10), env)).toMatchObject({ leftUsd: 6 });
      await addApiSpend('acme/app', 6 - MIN_LEFT_USD + 0.01);
      expect(await apiFallbackFor(repo(10), env)).toBeNull();
      expect(await apiFallbackFor({ productRepo: 'acme/app' }, env)).toBeNull();
      expect(await apiFallbackFor(repo(100), {})).toBeNull();
    });
  });
}

behaves('the API budget, in files', async () => {
  setDb(null);
  rmSync(join(dir, 'api-budget.json'), { force: true });
});

describe.skipIf(!TEST_DATABASE_URL)('in Postgres', () => {
  let db: Awaited<ReturnType<typeof testDb>>['db'];
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });

  behaves('the API budget, in Postgres', async () => {
    setDb(db);
    await db.deleteFrom('api_budgets').execute();
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
