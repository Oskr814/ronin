import { sql, type Kysely } from 'kysely';

// What the team decided on each finding of an exploration PR (#446), from
// the tablero: approve or reject, with the reason and who. Shared by
// everyone reviewing it, and written into the PR (the finding's estado,
// knowledge.md) all at once when the review is finished.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('finding_decisions')
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('pr', 'integer', (c) => c.notNull())
    .addColumn('ficha', 'text', (c) => c.notNull())
    .addColumn('decision', 'text', (c) => c.notNull())
    .addColumn('reason', 'text')
    .addColumn('decided_by', 'text', (c) => c.notNull())
    .addColumn('decided_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('applied_at', 'timestamptz')
    .addPrimaryKeyConstraint('finding_decisions_pk', ['repo', 'pr', 'ficha'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('finding_decisions').execute();
}
