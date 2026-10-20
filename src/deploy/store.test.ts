import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { config } from '../core/config.js';
import { setDb, type Db } from '../db/db.js';
import { TEST_DATABASE_URL, testDb } from '../db/testing.js';
import { addDeploy, listDeploys, putDeploy, updateDeploy, type DeployRecord } from './store.js';

const deploy = (tag: string, at: string, over: Partial<DeployRecord> = {}): DeployRecord => ({
  repo: 'acme/app', tag, prerelease: false, mode: 'pick', base: 'v0.9.0', sha: 'abc', url: `https://github.com/acme/app/releases/tag/${tag}`,
  changes: [{ pr: 3, subject: 'fix: algo (#3)' }, { pr: null, subject: 'chore: otra cosa' }], pedidos: [7, 9], by: 'persona', at, state: 'running', ...over,
});

// The same behavior, whichever keeps them.
function behaves(name: string, setup: () => Promise<void>) {
  describe(name, () => {
    beforeEach(setup);

    it('lists them newest first, by repo, as they were saved', async () => {
      await addDeploy(deploy('v1.0.0', '2026-10-18T10:00:00.000Z'));
      await addDeploy(deploy('v1.1.0', '2026-10-19T10:00:00.000Z', { releaseError: 'HTTP 502' }));
      await addDeploy(deploy('v2.0.0', '2026-10-17T10:00:00.000Z', { repo: 'acme/otra', mode: 'all', base: null }));
      expect((await listDeploys()).map((d) => d.tag)).toEqual(['v1.1.0', 'v1.0.0', 'v2.0.0']);
      expect(await listDeploys('acme/otra')).toEqual([deploy('v2.0.0', '2026-10-17T10:00:00.000Z', { repo: 'acme/otra', mode: 'all', base: null })]);
      expect((await listDeploys('acme/app'))[0]).toEqual(deploy('v1.1.0', '2026-10-19T10:00:00.000Z', { releaseError: 'HTTP 502' }));
    });

    it('changes one in place, and says when there is none', async () => {
      await addDeploy(deploy('v1.0.0', '2026-10-18T10:00:00.000Z'));
      const runs = [{ name: 'deploy', conclusion: 'success', url: 'https://github.com/acme/app/actions/runs/1' }];
      const changed = await updateDeploy('acme/app', 'v1.0.0', (r) => { r.state = 'deployed'; r.runs = runs; r.endedAt = '2026-10-18T10:20:00.000Z'; });
      expect(changed).toMatchObject({ state: 'deployed', runs, endedAt: '2026-10-18T10:20:00.000Z' });
      expect((await listDeploys())[0]).toEqual(changed);
      expect(await updateDeploy('acme/app', 'v9', () => {})).toBeUndefined();
    });

    it('takes changes to one at a time, so none is lost', async () => {
      await addDeploy(deploy('v1.0.0', '2026-10-18T10:00:00.000Z', { pedidos: [] }));
      await Promise.all([1, 2, 3, 4, 5].map((n) => updateDeploy('acme/app', 'v1.0.0', (r) => { r.pedidos.push(n); })));
      expect((await listDeploys())[0].pedidos.sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });
}

behaves('deploy store, in a file (without DATABASE_URL)', async () => {
  setDb(null);
  rmSync(config.deploys.dataDir, { recursive: true, force: true });
});

describe.skipIf(!TEST_DATABASE_URL)('with Postgres', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });

  behaves('deploy store, in Postgres', async () => {
    setDb(db);
    await db.deleteFrom('deploys').execute();
  });

  it('imports one over the one with its repo and tag', async () => {
    setDb(db);
    await db.deleteFrom('deploys').execute();
    await putDeploy(deploy('v1.0.0', '2026-10-18T10:00:00.000Z'));
    await putDeploy(deploy('v1.0.0', '2026-10-18T10:00:00.000Z', { state: 'deployed' }));
    expect(await listDeploys()).toEqual([deploy('v1.0.0', '2026-10-18T10:00:00.000Z', { state: 'deployed' })]);
  });
});
