// `pnpm db:import-usage`: copies each Claude account's usage
// (logs/usage/<account>.json, and its history in
// logs/usage/history/<account>.jsonl) into DATABASE_URL's database (#235,
// stage 3.5). The files stay where they are, as a backup. Safe to run again
// (an account's history is replaced by its file's). Ends comparing both.
import { closeDb, getDb, setDb } from '@platform/db/db.js';
import { migrateToLatest } from '@platform/db/migrate.js';
import { addUsageHistory, listUsage, putUsage, readUsageHistory, usageHistory, type AccountUsage } from '@platform/claude/claude-usage.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);
// What the files have: listUsage reads them without a database.
setDb(null);
const inFiles: AccountUsage[] = await listUsage();
setDb(db);
let failed = false;
for (const usage of inFiles) {
  await putUsage(db, usage);
  const history = readUsageHistory(usage.account);
  await db.deleteFrom('claude_usage_history').where('account', '=', usage.account).execute();
  for (const entry of history) await addUsageHistory(db, usage.account, entry);
  const same = sameContent(await usageHistory(usage.account), history);
  failed ||= !same;
  console.log(`${usage.account}: ${history.length} mediciones. ${same ? 'Iguales.' : 'DISTINTAS.'}`);
}
const inDb = await listUsage();
const differ = !sameContent(inDb, inFiles);
console.log(`Cuentas: ${inFiles.length} en los archivos, ${inDb.length} en la base. ${differ ? 'DISTINTAS.' : 'Iguales.'}`);
await closeDb();
if (failed || differ) process.exit(1);
