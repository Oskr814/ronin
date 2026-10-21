import { sql, type Kysely } from 'kysely';

// Who works on what (#235, stage 3.2): the locks on issues and PRs and the
// agent slots of each repo, which were pid files under .locks/ and
// .ronin-slots/. Each is held by a process (host:pid) with a lease it
// renews; one whose lease ran out — or whose process on this host is gone —
// is taken over. And what's waiting for a slot, for the dashboard's queue.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('locks')
    .addColumn('scope', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('holder', 'text', (c) => c.notNull())
    .addColumn('host', 'text', (c) => c.notNull())
    .addColumn('pid', 'integer', (c) => c.notNull())
    .addColumn('acquired_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('lease_until', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('locks_pkey', ['scope', 'name'])
    .execute();
  await db.schema.createIndex('locks_holder').on('locks').column('holder').execute();
  await db.schema.createTable('lock_waits')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('holder', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('repo', 'text')
    .addColumn('since', 'timestamptz', (c) => c.notNull())
    .addColumn('lease_until', 'timestamptz', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('lock_waits').execute();
  await db.schema.dropTable('locks').execute();
}
