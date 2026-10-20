import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { createDb, type Db } from './db.js';
import { migrateToLatest } from './migrate.js';

// For the tests that need a real Postgres (#235: repositories are tested
// against one). TEST_DATABASE_URL points at it — a service in the CI, and
// `docker compose -f compose.test.yml up -d` locally; without it, those
// tests are skipped. Each test file gets a schema of its own, migrated, and
// drops it at the end.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function testDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('falta TEST_DATABASE_URL');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = createDb(TEST_DATABASE_URL, { schema });
  await migrateToLatest(db, schema);
  return {
    db,
    drop: async () => {
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
      await db.destroy();
    },
  };
}
