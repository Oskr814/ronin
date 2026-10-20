import { sql, type Kysely } from 'kysely';

// Despliegues (#158): each release ronin published. What it carried (its
// PRs and portal requests) and how its workflow ended are kept as they are
// in the record (jsonb, int[]): they're read and written with the deploy.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('deploys')
    .addColumn('repo', 'text', (c) => c.notNull())
    .addColumn('tag', 'text', (c) => c.notNull())
    .addColumn('prerelease', 'boolean', (c) => c.notNull())
    .addColumn('mode', 'text', (c) => c.notNull())
    .addColumn('base', 'text')
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('changes', 'jsonb', (c) => c.notNull())
    .addColumn('pedidos', sql`integer[]`, (c) => c.notNull())
    .addColumn('by', 'text', (c) => c.notNull())
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('runs', 'jsonb')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('release_error', 'text')
    .addPrimaryKeyConstraint('deploys_pkey', ['repo', 'tag'])
    .execute();
  await db.schema.createIndex('deploys_repo_at').on('deploys').columns(['repo', 'at']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('deploys').execute();
}
