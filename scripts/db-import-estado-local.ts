// `pnpm db:import-estado-local`: copies the local state of each repo in
// repos.json (<LOCAL_STATE_PATH>.<owner-repo>.json) into DATABASE_URL's
// database (#235, stage 3.3): its claims, its comments done, its block
// reasons… The files stay where they are, as a backup. Safe to run again
// (each repo's rows are replaced by its file). Ends comparing both.
import { closeDb, getDb } from '../src/platform/db/db.js';
import { migrateToLatest } from '../src/platform/db/migrate.js';
import { fromEntries, readStateDb, toEntries, writeStateDb } from '../src/platform/state/local-state-db.js';
import { readStateFile, statePath } from '../src/platform/state/local-state.js';
import { loadRepos } from '../src/platform/config/repos.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);
let failed = false;
for (const { productRepo } of await loadRepos()) {
  const inFile = await readStateFile(statePath(productRepo));
  await writeStateDb(db, productRepo, inFile);
  // Through fromEntries, as the file read back from the database: sorted, the
  // claims, which the file keeps in the order they came.
  const same = sameContent(await readStateDb(db, productRepo), fromEntries(toEntries(inFile)));
  failed ||= !same;
  console.log(`${productRepo}: ${inFile.claimedIssues.length} claims, ${Object.keys(inFile.processedComments).length} comentarios, ${Object.keys(inFile.blocks).length} bloqueos. ${same ? 'Iguales.' : 'DISTINTOS.'}`);
}
await closeDb();
if (failed) process.exit(1);
