import { afterAll, beforeAll, beforeEach, it } from 'vitest';
import { setDb, type Db } from '../../platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '../../platform/db/testing.js';

// accounts.test.ts and requests.test.ts again, with the portal's data in
// Postgres (#235, stage 2): the same behavior, whichever keeps it.
if (TEST_DATABASE_URL) {
  process.env.RONIN_TEST_STORE = 'pg';
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('portal_users').execute();
    await db.deleteFrom('portal_requests').execute();
  });
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  await import('./accounts.test.js');
  await import('./requests.test.js');
} else {
  it.skip('needs TEST_DATABASE_URL', () => {});
}
