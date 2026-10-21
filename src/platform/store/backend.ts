import { sql, type Transaction } from 'kysely';
import { getDb, type Db } from '../db/db.js';
import type { Database } from '../db/schema.js';
import { timed } from '../timing.js';

// Every store keeps its data in Postgres when DATABASE_URL is set (#235,
// stage 2), else in its files as before: the code can be deployed first and
// switched over after (scripts/db-import-*.ts), and taking the variable out
// goes back to the files.

export type Trx = Transaction<Database>;

// One operation on whichever keeps the data; the database's is timed as
// Server-Timing's db (#235, stage 1).
export function onStore<T>(ops: { db: (db: Db) => Promise<T>; files: () => T | Promise<T> }): Promise<T> {
  const db = getDb();
  return db ? timed('db', () => ops.db(db)) : Promise.resolve(ops.files());
}

// What only makes sense on the database: the imports' writes.
export function requireDb(): Db {
  const db = getDb();
  if (!db) throw new Error('falta DATABASE_URL');
  return db;
}

// Postgres's advisory locks, one key per store: changes that read and write
// more than one row (a new number, a whole list) take turns on theirs, as
// the file's lock made them. Each key in one place, so no two stores share
// one by accident.
export const STORE_LOCKS = {
  meetings: 62_001,
  portalAccounts: 114_001,
  portalRequests: 114_002,
  settings: 174_001,
} as const;

export type StoreLock = keyof typeof STORE_LOCKS;

// Waits its turn on the store's key until the transaction ends.
export async function takeTurn(trx: Trx, lock: StoreLock): Promise<void> {
  await sql`select pg_advisory_xact_lock(${STORE_LOCKS[lock]})`.execute(trx);
}
