import { sql, type Kysely } from 'kysely';

// The request portal (#114). Each account is a row with its record as a
// jsonb document (it holds a password's hash and a link's: never shown);
// email is its own column, unique. Each request, like a meeting, is one
// document with user, repo and status as columns. Images and prototype
// diffs stay files (requests/<n>/).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('portal_users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable('portal_requests')
    .addColumn('number', 'integer', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('data', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('portal_requests_user').on('portal_requests').column('user_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('portal_requests').execute();
  await db.schema.dropTable('portal_users').execute();
}
