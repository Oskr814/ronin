import { sql, type Kysely } from 'kysely';

// Reuniones (#62): each meeting whose notes the team uploaded. The whole
// record (its proposals, what was created, its activity) is one jsonb
// document, read and written with the meeting; repo, hash and status are
// columns too, to find one and to keep the same notes from coming in twice.
// The notes and the uploaded file stay files (meetings/<n>/).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('meetings')
    .addColumn('number', 'integer', (c) => c.primaryKey())
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('hash', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('meetings_repo_hash', ['repo', 'hash'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('meetings').execute();
}
