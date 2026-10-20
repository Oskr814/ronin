import { Migrator } from 'kysely/migration';
import type { Db } from './db.js';
import { migrations } from './migrations/index.js';

// Brings the database up to the last migration. The server runs it when it
// starts (server/index.ts), and `pnpm db:migrate` by hand. Kysely keeps
// which ones ran in kysely_migration, and a lock makes two processes
// starting at once take turns. `schema`: where those two tables go (the
// tests' own schema; by default, public).
export async function migrateToLatest(db: Db, schema?: string): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations }, ...(schema ? { migrationTableSchema: schema } : {}) });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) throw new Error(`la migración ${failed?.migrationName ?? ''} falló: ${(error as Error | undefined)?.message ?? 'sin detalle'}`.replace('  ', ' '));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
