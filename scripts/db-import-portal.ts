// `pnpm db:import-portal`: copies the request portal's accounts.json and
// each requests/<n>/request.json into DATABASE_URL's database (#235, stage
// 2), with their ids and numbers. Images and prototype diffs stay where they
// are (the database doesn't keep them), and so do the JSON files, as a
// backup. Safe to run again. Ends comparing both.
import { closeDb, getDb } from '../src/db/db.js';
import { migrateToLatest } from '../src/db/migrate.js';
import { fileUsers, listUsers, putUsers } from '../src/portal/accounts.js';
import { fileRequests, listRequests, putRequest } from '../src/portal/requests.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);

const users = await fileUsers();
await putUsers(users);
const usersInDb = new Map((await listUsers()).map((u) => [u.id, u]));
const usersDiffer = users.filter((u) => !sameContent(usersInDb.get(u.id), u));

const requests = await fileRequests();
for (const request of requests) await putRequest(request);
const requestsInDb = new Map((await listRequests()).map((r) => [r.number, r]));
const requestsDiffer = requests.filter((r) => !sameContent(requestsInDb.get(r.number), r));

console.log(`Cuentas: ${users.length} en el archivo, ${usersInDb.size} en la base. ${usersDiffer.length ? `DISTINTAS: ${usersDiffer.length}` : 'Iguales.'}`);
console.log(`Pedidos: ${requests.length} en los archivos, ${requestsInDb.size} en la base. ${requestsDiffer.length ? `DISTINTOS: ${requestsDiffer.map((r) => `P-${r.number}`).join(', ')}` : 'Iguales.'}`);
await closeDb();
if (usersDiffer.length || requestsDiffer.length) process.exit(1);
