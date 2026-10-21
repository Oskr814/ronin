import { sql, type Kysely } from 'kysely';

// Ajustes (#174): the values changed from the dashboard, each task type's
// model and effort, each Claude account's plan, and the record of changes.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('updated_by', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable('task_settings')
    .addColumn('task_type', 'text', (c) => c.primaryKey())
    .addColumn('model', 'text')
    .addColumn('effort', 'text')
    .addColumn('updated_by', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable('claude_account_plans')
    .addColumn('account', 'text', (c) => c.primaryKey())
    .addColumn('choice', 'jsonb', (c) => c.notNull())
    .addColumn('updated_by', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable('settings_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .addColumn('login', 'text', (c) => c.notNull())
    .addColumn('what', 'text', (c) => c.notNull())
    .addColumn('from_value', 'text', (c) => c.notNull())
    .addColumn('to_value', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('settings_log_at').on('settings_log').column('at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['settings_log', 'claude_account_plans', 'task_settings', 'settings']) await db.schema.dropTable(table).execute();
}
