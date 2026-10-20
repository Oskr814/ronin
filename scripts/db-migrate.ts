// `pnpm db:migrate`: brings DATABASE_URL's database up to the last
// migration (src/db/migrations). The server does it when it starts; this is
// for doing it by hand, before switching a module over.
import { closeDb, getDb } from '../src/db/db.js';
import { migrateToLatest } from '../src/db/migrate.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
const ran = await migrateToLatest(db);
console.log(ran.length ? `Migraciones aplicadas: ${ran.join(', ')}` : 'La base ya estaba al día.');
await closeDb();
