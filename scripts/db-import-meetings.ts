// `pnpm db:import-meetings`: copies each <MEETINGS_DATA_DIR>/meetings/<n>/
// meeting.json into DATABASE_URL's database (#235, stage 2), with its
// number. The notes and the uploaded files stay where they are (the database
// doesn't keep them), and so do meeting.json and counter.json, as a backup.
// Safe to run again. Ends comparing both.
import { closeDb, getDb } from '@platform/db/db.js';
import { migrateToLatest } from '@platform/db/migrate.js';
import { fileMeetings, listMeetings, putMeeting } from '@domains/meetings/meetings.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);
const inFile = await fileMeetings();
for (const meeting of inFile) await putMeeting(meeting);
const inDb = new Map((await listMeetings()).map((m) => [m.number, m]));
const differ = inFile.filter((m) => !sameContent(inDb.get(m.number), m));
console.log(`Reuniones: ${inFile.length} en los archivos, ${inDb.size} en la base. ${differ.length ? `DISTINTAS: ${differ.map((m) => `R-${m.number}`).join(', ')}` : 'Iguales.'}`);
await closeDb();
if (differ.length) process.exit(1);
