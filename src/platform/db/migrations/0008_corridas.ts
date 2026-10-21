import { sql, type Kysely } from 'kysely';

// The index of the agents' runs (platform/agents/runs-store.ts): what the dashboard
// lists, which it read by walking logs/runs/. One row per run, written when
// it starts and when it ends; its transcript stays a file
// (logs/runs/<day>/<run_id>.jsonl). `day` is the local day the file is
// under, which is how a listing picks the runs of the last few days.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('runs')
    .addColumn('run_id', 'text', (c) => c.primaryKey())
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('task_type', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('issue_number', 'integer')
    .addColumn('pr_number', 'integer')
    .addColumn('portal_request', 'integer')
    .addColumn('meeting', 'integer')
    .addColumn('slice_index', 'integer')
    .addColumn('slice_title', 'text')
    .addColumn('grp', 'text')
    .addColumn('model', 'text')
    .addColumn('effort', 'text')
    .addColumn('account', 'text', (c) => c.notNull())
    .addColumn('worktree', 'text', (c) => c.notNull())
    .addColumn('host', 'text')
    .addColumn('pid', 'integer')
    .addColumn('started_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ended_at', 'timestamptz')
    .addColumn('duration_ms', 'integer')
    .addColumn('outcome', 'text')
    .addColumn('cost_usd', 'double precision')
    .addColumn('error', 'text')
    .addColumn('steps', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_step', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('runs_day').on('runs').column('day').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('runs').execute();
}
