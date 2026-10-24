import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_ajustes.js';
import * as m0002 from './0002_despliegues.js';
import * as m0003 from './0003_reuniones.js';
import * as m0004 from './0004_portal.js';
import * as m0005 from './0005_jobs.js';
import * as m0006 from './0006_locks.js';
import * as m0007 from './0007_estado_local.js';
import * as m0008 from './0008_corridas.js';
import * as m0009 from './0009_cuota.js';
import * as m0010 from './0010_api_fallback.js';
import * as m0011 from './0011_commands.js';
import * as m0012 from './0012_finding_decisions.js';

// Every migration, in order, by name. Listed here rather than read from the
// folder: they're compiled into dist like the rest, and a missing one is a
// type error, not a surprise at startup. A migration is never edited once
// merged: a change is a new one.
export const migrations: Record<string, Migration> = {
  '0001_ajustes': m0001,
  '0002_despliegues': m0002,
  '0003_reuniones': m0003,
  '0004_portal': m0004,
  '0005_jobs': m0005,
  '0006_locks': m0006,
  '0007_estado_local': m0007,
  '0008_corridas': m0008,
  '0009_cuota': m0009,
  '0010_api_fallback': m0010,
  '0011_commands': m0011,
  '0012_finding_decisions': m0012,
};
