import { sql, type Kysely } from 'kysely';

// What someone asked ronin for from the tablero (#446): a preview, a
// decision on a finding… kept here instead of written as a comment on
// GitHub. Its answers (`messages`) and how it went are ronin's to show; the
// comments people leave on GitHub go on working as before. A command
// waiting or running with a dedupe key is never asked twice: the second
// one gets the first.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('commands')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('number', 'integer', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('args', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('requested_by', 'text', (c) => c.notNull())
    .addColumn('dedupe_key', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('messages', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('run_id', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('commands_item').on('commands').columns(['repo', 'number', 'created_at']).execute();
  await sql`create unique index commands_dedupe_open on commands (dedupe_key) where status in ('queued', 'running')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('commands').execute();
}
