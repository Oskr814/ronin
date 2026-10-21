// `pnpm db:import-settings`: copies Ajustes from SETTINGS_DATA_DIR's files
// into DATABASE_URL's database (#235, stage 2) — settings.json (values, task
// types, Claude accounts' plans) and registro.jsonl. The files stay as they
// are, as a backup. Safe to run again: the values are written over, and the
// record is only copied into an empty table. Ends comparing both.
import { join, resolve } from 'node:path';
import { closeDb, getDb, setDb } from '@platform/db/db.js';
import { migrateToLatest } from '@platform/db/migrate.js';
import { readSettingsSync } from '@platform/config/settings.js';
import { appendSettingsLog, readSettingsLog, readSettings, updateSettings } from '@platform/config/settings-store.js';
import { sameContent } from './db-compare.js';

const dataDir = resolve(process.env.SETTINGS_DATA_DIR || 'settings-data');
const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);

const file = readSettingsSync(dataDir);
await updateSettings(dataDir, 'importado', (current) => {
  current.values = { ...file.values };
  current.tasks = { ...(file.tasks ?? {}) };
  current.accounts = { ...(file.accounts ?? {}) };
});

// The record, oldest first, only into an empty table.
setDb(null);
const logEntries = (await readSettingsLog(dataDir, Number.MAX_SAFE_INTEGER)).reverse();
setDb(db);
const already = Number((await db.selectFrom('settings_log').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
if (already === 0) for (const entry of logEntries) await appendSettingsLog(dataDir, entry);
else console.log(`El registro ya tenía ${already} cambios en la base: no se copió de nuevo.`);

const inDb = await readSettings(dataDir);
const same = sameContent(inDb, { values: file.values, ...(file.tasks && Object.keys(file.tasks).length ? { tasks: file.tasks } : {}), ...(file.accounts && Object.keys(file.accounts).length ? { accounts: file.accounts } : {}) });
const logCount = Number((await db.selectFrom('settings_log').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
console.log(`Ajustes: ${Object.keys(file.values).length} valores, ${Object.keys(file.tasks ?? {}).length} tareas, ${Object.keys(file.accounts ?? {}).length} cuentas en ${join(dataDir, 'settings.json')}.`);
console.log(`En la base: ${same ? 'iguales' : 'DISTINTOS, revisar'}. Registro: ${logEntries.length} en el archivo, ${logCount} en la base.`);
await closeDb();
if (!same || logCount < logEntries.length) process.exit(1);
