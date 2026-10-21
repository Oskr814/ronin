import { sql, type Kysely } from 'kysely';

// The job queue (#235, stage 3): what the cron tick and the webhook handlers
// were, as rows a runner takes. A queued job with a dedupe key is never
// queued twice (a partial unique index); a running one carries a lease its
// process renews.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('jobs')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('repo', 'text')
    .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('dedupe_key', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('run_after', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('lease_until', 'timestamptz')
    .addColumn('runner', 'text')
    .addColumn('pid', 'integer')
    .addColumn('error', 'text')
    .execute();
  await db.schema.createIndex('jobs_queued').on('jobs').columns(['status', 'run_after']).execute();
  await db.schema.createIndex('jobs_kind_started').on('jobs').columns(['kind', 'started_at']).execute();
  await sql`create unique index jobs_dedupe_queued on jobs (dedupe_key) where status = 'queued'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('jobs').execute();
}
