import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Db } from '../db/db.js';
import { readJson, withJson, writeJson } from '../fs/atomic-json.js';
import { onStore, requireDb, takeTurn, type StoreLock, type Trx } from './backend.js';

// Documents numbered 1, 2, 3… across every repo (a meeting, a portal
// request), each read and written whole. In Postgres, a row each in `table`,
// the document in its `data` column with a few columns beside it to filter
// on; in files, <dir>/<n>/<file> and the last number in <dir>/counter.json.

export interface NumberedDoc {
  number: number;
  createdAt: string;
  updatedAt: string;
}

export interface Counter {
  last: number;
}

export interface DocumentStoreSpec<T extends NumberedDoc, C extends Counter> {
  table: 'meetings' | 'portal_requests';
  // The key a new number takes turns on.
  lock: StoreLock;
  // The row's columns besides number, data and the dates.
  columns: (doc: T) => Record<string, string>;
  dir: () => string;
  file: string;
  // The counter's file may carry more than the last number (a meeting's
  // notes by their hash).
  emptyCounter: () => C;
  // What updating one that isn't there throws.
  missing: () => never;
}

// Checks run under the lock a new number takes, before it's given: the
// database's in its transaction, the files' with the counter, where they can
// also note something on it for `next`.
export interface CreateChecks<C extends Counter> {
  db?: (trx: Trx) => Promise<void>;
  files?: (counter: C, next: number) => Promise<void>;
}

export function documentStore<T extends NumberedDoc, C extends Counter>(spec: DocumentStoreSpec<T, C>) {
  const path = (n: number) => join(spec.dir(), String(n), spec.file);
  const counterPath = () => join(spec.dir(), 'counter.json');
  const rowOf = (doc: T) => ({
    number: doc.number,
    ...spec.columns(doc),
    data: JSON.stringify(doc),
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  });
  // The table without its types: each store brings its own columns.
  const table = (db: Db | Trx) => (db as unknown as Kysely<Record<string, { number: number; data: unknown }>>);

  // Every one in the folder, as its file has them (also for the import).
  async function files(): Promise<T[]> {
    const { last } = await readJson<Counter>(counterPath(), spec.emptyCounter);
    const all: Array<T | undefined> = await Promise.all(Array.from({ length: last }, (_, i) => readJson<T | undefined>(path(i + 1), () => undefined)));
    return all.filter((doc): doc is T => Boolean(doc));
  }

  return {
    get(n: number): Promise<T | undefined> {
      if (!Number.isInteger(n) || n < 1) return Promise.resolve(undefined);
      return onStore({
        db: async (db) => (await table(db).selectFrom(spec.table).select('data').where('number', '=', n).executeTakeFirst())?.data as T | undefined,
        files: () => readJson<T | undefined>(path(n), () => undefined),
      });
    },

    // By number.
    list(): Promise<T[]> {
      return onStore({
        db: async (db) => (await table(db).selectFrom(spec.table).select('data').orderBy('number').execute()).map((r) => r.data as T),
        files,
      });
    },

    // The ones whose `column` is `value`, by number; `keep` is the same
    // filter on the files.
    listWhere(column: string, value: string, keep: (doc: T) => boolean): Promise<T[]> {
      return onStore({
        db: async (db) => (await table(db).selectFrom(spec.table).select('data').where(column as 'number', '=', value as never).orderBy('number').execute()).map((r) => r.data as T),
        files: async () => (await files()).filter(keep),
      });
    },

    // Changes one through `fn`, taking turns with anyone else changing it;
    // its updatedAt is now.
    update<R>(n: number, fn: (doc: T) => R | Promise<R>): Promise<R> {
      const change = async (doc: T) => {
        const result = await fn(doc);
        doc.updatedAt = new Date().toISOString();
        return result;
      };
      return onStore({
        db: (db) => db.transaction().execute(async (trx) => {
          const row = await table(trx).selectFrom(spec.table).select('data').where('number', '=', n).forUpdate().executeTakeFirst();
          if (!row) spec.missing();
          const doc = row!.data as T;
          const result = await change(doc);
          const { number: _n, created_at: _c, ...rest } = rowOf(doc);
          await table(trx).updateTable(spec.table).set(rest as never).where('number', '=', n).execute();
          return result;
        }),
        files: () => withJson(path(n), spec.missing, change),
      });
    },

    // A new one with the next number: `build` writes whatever goes with it
    // besides the document (a meeting's notes, a request's images) before
    // it's saved, so none is left without them.
    create(build: (number: number) => Promise<T>, checks: CreateChecks<C> = {}): Promise<T> {
      return onStore({
        db: (db) => db.transaction().execute(async (trx) => {
          await takeTurn(trx, spec.lock);
          await checks.db?.(trx);
          const { last } = await table(trx).selectFrom(spec.table).select((eb) => eb.fn.coalesce(eb.fn.max('number'), sql<number>`0`).as('last')).executeTakeFirstOrThrow();
          const doc = await build(Number(last) + 1);
          await table(trx).insertInto(spec.table).values(rowOf(doc) as never).execute();
          return doc;
        }),
        files: async () => {
          const number = await withJson(counterPath(), spec.emptyCounter, async (counter) => {
            await checks.files?.(counter, counter.last + 1);
            return ++counter.last;
          });
          const doc = await build(number);
          await writeJson(path(number), doc);
          return doc;
        },
      });
    },

    // The import: writes one as it is, with its number.
    async put(doc: T): Promise<void> {
      const row = rowOf(doc);
      const { number: _n, ...rest } = row;
      await table(requireDb()).insertInto(spec.table).values(row as never).onConflict((oc) => oc.column('number').doUpdateSet(rest as never)).execute();
    },

    files,
  };
}
