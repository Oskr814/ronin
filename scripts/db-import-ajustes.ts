// `pnpm db:import-ajustes`: copies Ajustes from SETTINGS_DATA_DIR's files
// into DATABASE_URL's database (#235, stage 2) — settings.json (values, task
// types, Claude accounts' plans) and registro.jsonl. The files stay as they
// are, as a backup. Safe to run again: the values are written over, and the
// record is only copied into an empty table. Ends comparing both.
import { join, resolve } from 'node:path';
import { closeDb, getDb, setDb } from '../src/db/db.js';
import { migrateToLatest } from '../src/db/migrate.js';
import { readSettingsSync } from '../src/core/settings.js';
import { appendRegistro, readRegistro, readSettings, updateSettings } from '../src/core/settings-store.js';

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
const registro = (await readRegistro(dataDir, Number.MAX_SAFE_INTEGER)).reverse();
setDb(db);
const already = Number((await db.selectFrom('settings_log').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
if (already === 0) for (const entry of registro) await appendRegistro(dataDir, entry);
else console.log(`El registro ya tenía ${already} cambios en la base: no se copió de nuevo.`);

const inDb = await readSettings(dataDir);
const same = JSON.stringify(inDb) === JSON.stringify({ values: file.values, ...(file.tasks && Object.keys(file.tasks).length ? { tasks: file.tasks } : {}), ...(file.accounts && Object.keys(file.accounts).length ? { accounts: file.accounts } : {}) });
const logCount = Number((await db.selectFrom('settings_log').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
console.log(`Ajustes: ${Object.keys(file.values).length} valores, ${Object.keys(file.tasks ?? {}).length} tareas, ${Object.keys(file.accounts ?? {}).length} cuentas en ${join(dataDir, 'settings.json')}.`);
console.log(`En la base: ${same ? 'iguales' : 'DISTINTOS, revisar'}. Registro: ${registro.length} en el archivo, ${logCount} en la base.`);
await closeDb();
if (!same || logCount < registro.length) process.exit(1);
