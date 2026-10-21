// `pnpm db:import-deploys`: copies <DEPLOYS_DATA_DIR>/deploys.json into
// DATABASE_URL's database (#235, stage 2). The file stays as it is, as a
// backup. Safe to run again: each deploy is written over the one with its
// repo and tag. Ends comparing both.
import { closeDb, getDb } from '../src/platform/db/db.js';
import { migrateToLatest } from '../src/platform/db/migrate.js';
import { fileDeploys, listDeploys, putDeploy } from '../src/domains/deploys/store.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);
const inFile = await fileDeploys();
for (const record of inFile) await putDeploy(record);
const key = (d: { repo: string; tag: string }) => `${d.repo}@${d.tag}`;
const inDb = new Map((await listDeploys()).map((d) => [key(d), d]));
const differ = inFile.filter((d) => !sameContent(inDb.get(key(d)), d));
console.log(`Despliegues: ${inFile.length} en el archivo, ${inDb.size} en la base. ${differ.length ? `DISTINTOS: ${differ.map(key).join(', ')}` : 'Iguales.'}`);
await closeDb();
if (differ.length) process.exit(1);
