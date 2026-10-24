import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { RunRecord } from '@platform/agents/run-record.js';
import { listRunsDb } from '@platform/agents/runs-store.js';
import { listRuns } from '@domains/runs/data.js';

// The index of the runs in Postgres (#235, stage 3.4): what RunRecord
// writes, and what the dashboard lists from it.
describe.skipIf(!TEST_DATABASE_URL)('the runs index', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('runs').execute();
    process.env.RONIN_LOGS_DIR = mkdtempSync(join(tmpdir(), 'ronin-runs-db-'));
  });

  const context = { repo: 'acme/product', taskType: 'implement-slice', label: 'issue #879', issueNumber: 879, sliceIndex: 1, sliceTitle: 'Validar stock', account: 'acme', worktree: '/w' };

  it('gets a row when the run starts and its end when it ends', async () => {
    const now = new Date();
    const record = RunRecord.start(context, now);
    record.step({ kind: 'tool', name: 'Bash', summary: '$ pnpm test' });
    record.result({ costUsd: 0.25 });
    await record.end('error', new Error('falló'), new Date(now.getTime() + 60_000));
    const [{ summary }] = await listRunsDb(db, [record.path.split('/').at(-2)!]);
    expect(summary).toMatchObject({ runId: record.runId, issueNumber: 879, sliceIndex: 1, sliceTitle: 'Validar stock', state: 'error', error: 'falló', costUsd: 0.25, durationMs: 60_000, steps: 1, lastStep: '$ pnpm test' });
    expect(summary).not.toHaveProperty('prNumber');
  });

  it('keeps a run paid by API apart, in the row and in the file (#421)', async () => {
    const api = RunRecord.start({ ...context, billing: 'api' });
    await api.end('ok');
    const plain = RunRecord.start(context);
    await plain.end('ok');
    const runs = await listRuns(1);
    expect(runs.find((r) => r.runId === api.runId)).toMatchObject({ billing: 'api' });
    expect(runs.find((r) => r.runId === plain.runId)).not.toHaveProperty('billing');
    setDb(null);
    expect((await listRuns(1)).find((r) => r.runId === api.runId)).toMatchObject({ billing: 'api' });
    setDb(db);
  });

  it('lists a run still going with its steps from the file, and catches up one whose end only the file has', async () => {
    const going = RunRecord.start(context);
    going.step({ kind: 'text', text: 'Arranco' });
    const ended = RunRecord.start({ ...context, issueNumber: 880 });
    await new Promise((r) => setTimeout(r, 50));
    // Its end, written to the file while the database was out.
    setDb(null);
    await ended.end('ok');
    setDb(db);

    const runs = await listRuns(1);
    expect(runs.find((r) => r.runId === going.runId)).toMatchObject({ state: 'running', steps: 1, lastStep: 'Arranco' });
    expect(runs.find((r) => r.runId === ended.runId)?.state).toBe('ok');
    const row = await db.selectFrom('runs').select('outcome').where('run_id', '=', ended.runId).executeTakeFirst();
    expect(row?.outcome).toBe('ok');
  });

  it('tells a run whose process died without closing it', async () => {
    const day = '2026-10-16';
    const runId = '20261016T100000-implement-slice-879-dead';
    await db.insertInto('runs').values({ run_id: runId, day, repo: 'acme/product', task_type: 'implement-slice', label: 'issue #879', account: 'acme', worktree: '/w', host: (await import('node:os')).hostname(), pid: 999_999_999, started_at: '2026-10-16T10:00:00Z' }).execute();
    mkdirSync(join(process.env.RONIN_LOGS_DIR!, 'runs', day), { recursive: true });
    expect((await listRuns(1, new Date(2026, 9, 16, 12)))[0]).toMatchObject({ runId, state: 'cut' });
    writeFileSync(join(process.env.RONIN_LOGS_DIR!, 'runs', day, `${runId}.jsonl`), `${JSON.stringify({ type: 'run_start', runId, repo: 'acme/product', taskType: 'implement-slice', label: 'x', account: 'acme', worktree: '/w', pid: 999_999_999, startedAt: '2026-10-16T10:00:00Z' })}\n`);
    expect((await listRuns(1, new Date(2026, 9, 16, 12)))[0].state).toBe('cut');
  });
});
