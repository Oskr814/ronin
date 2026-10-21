import { sql, type Kysely } from 'kysely';

// The local state of each repo (core/local-state.ts), which was a JSON file
// per repo (.ronin-state.<repo>.json): one row per entry — an issue ronin
// claimed, a PR's pending-checks count, a comment it's done with, a block
// reason… — by its kind and its key inside the kind (the issue or PR number,
// the comment, the app; '' for the ones the repo has only one of).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('repo_state')
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('repo_state_pkey', ['repo', 'kind', 'key'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('repo_state').execute();
}
