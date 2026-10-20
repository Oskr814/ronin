import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_ajustes.js';

// Every migration, in order, by name. Listed here rather than read from the
// folder: they're compiled into dist like the rest, and a missing one is a
// type error, not a surprise at startup. A migration is never edited once
// merged: a change is a new one.
export const migrations: Record<string, Migration> = {
  '0001_ajustes': m0001,
};
