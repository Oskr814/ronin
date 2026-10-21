import { sql, type Kysely } from 'kysely';

// The usage of each Claude account (core/claude-usage.ts), which was
// logs/usage/<account>.json and logs/usage/history/<account>.jsonl: its
// last measurement (a document, as the dashboard shows it) and every
// measurement before, for Métricas → Suscripción.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('claude_usage')
    .addColumn('account', 'text', (c) => c.primaryKey())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable('claude_usage_history')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('account', 'text', (c) => c.notNull())
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('claude_usage_history_account_at').on('claude_usage_history').columns(['account', 'at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('claude_usage_history').execute();
  await db.schema.dropTable('claude_usage').execute();
}
