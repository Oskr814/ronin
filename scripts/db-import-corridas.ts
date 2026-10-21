// `pnpm db:import-corridas`: indexes in DATABASE_URL's database (#235,
// stage 3.4) every run whose file is under logs/runs/: its repo, task,
// item, account, cost, outcome… The files stay where they are: they're
// still each run's transcript. Safe to run again. Ends comparing both.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/platform/db/db.js';
import { migrateToLatest } from '../src/platform/db/migrate.js';
import { logsDir } from '../src/platform/agents/run-files.js';
import { listRunsDb, putRun } from '../src/platform/agents/runs-store.js';
import { readRunLines, summarizeRun } from '../src/domains/runs/data.js';
import type { RunSummary } from '../src/platform/agents/run-record.js';
import { sameContent } from './db-compare.js';

const db = getDb();
if (!db) {
  console.error('Falta DATABASE_URL en .env.');
  process.exit(1);
}
await migrateToLatest(db);
const root = join(logsDir(), 'runs');
const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
const inFiles: RunSummary[] = [];
for (const day of days) {
  for (const file of readdirSync(join(root, day)).filter((f) => f.endsWith('.jsonl'))) {
    const lines = readRunLines(join(root, day, file));
    const summary = summarizeRun(lines);
    if (!summary) continue;
    await putRun(db, summary, typeof lines[0].pid === 'number' ? lines[0].pid : undefined);
    inFiles.push(summary);
  }
}
// The ended ones, whole; a run still going only by its id (its state and
// steps are read from its file while it goes).
const inDb = new Map((await listRunsDb(db, days)).map(({ summary }) => [summary.runId, summary]));
const differ = inFiles.filter((run) => (run.endedAt ? !sameContent(inDb.get(run.runId), run) : !inDb.has(run.runId)));
console.log(`Corridas: ${inFiles.length} en los archivos, ${inDb.size} en la base. ${differ.length ? `DISTINTAS: ${differ.map((r) => r.runId).join(', ')}` : 'Iguales.'}`);
await closeDb();
if (differ.length) process.exit(1);
