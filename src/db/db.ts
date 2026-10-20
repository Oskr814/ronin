import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// ronin's Postgres (#235, stage 2), through Kysely: typed queries, no ORM.
//
// DATABASE_URL in .env turns it on. Without it, every module still reads
// and writes its files, as before stage 2: the code can be deployed first
// and switched over after (scripts/db-import-*.ts), and taking the variable
// out goes back to the files. Read from process.env, not config: config
// itself loads the settings from here.
//
// A small pool per process (the server, each tick, each worker), which lets
// the process exit once it's idle: a tick ends when its work does.

export type Db = Kysely<Database>;

const POOL_MAX = 4;

export function createDb(url: string, opts: { schema?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX,
    allowExitOnIdle: true,
    // Tests run each file in a schema of its own (testing.ts).
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

let shared: Db | null | undefined;

// The process's database, or null when DATABASE_URL isn't set.
export function getDb(): Db | null {
  if (shared === undefined) shared = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : null;
  return shared;
}

// For tests: a database of their own, or none (null: the files).
export function setDb(db: Db | null): void {
  shared = db;
}

export async function closeDb(): Promise<void> {
  const db = shared;
  shared = undefined;
  await db?.destroy();
}
