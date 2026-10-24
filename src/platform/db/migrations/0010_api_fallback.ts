import { sql, type Kysely } from 'kysely';

// The API fallback (#421, platform/claude/api-fallback.ts). How a run was
// paid: null for the Claude subscription's quota, as every run so far;
// 'api' for one that finished on its repo's API key. And what each repo
// spent that way since its counter was last reset from Ajustes.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('runs').addColumn('billing', 'text').execute();
  await db.schema.createTable('api_budgets')
    .addColumn('repo', 'text', (c) => c.primaryKey())
    .addColumn('spent_usd', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('reset_at', 'timestamptz')
    .addColumn('reset_by', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('api_budgets').execute();
  await db.schema.alterTable('runs').dropColumn('billing').execute();
}
