import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import type { LocalState } from './local-state.js';

// The local state of a repo in Postgres (#235, stage 3.3), with
// DATABASE_URL: one row of repo_state per entry, so a write touches only
// the entries that changed, not the whole file.

interface Entry {
  kind: string;
  key: string;
  value: unknown;
}

// The fields kept as a record (key -> value), each its kind.
const RECORDS = {
  checksPendingCounts: 'checks-pending',
  lastReviewedSha: 'reviewed-sha',
  internalReviewedSha: 'internal-reviewed-sha',
  internalReviewFailed: 'internal-review-failed',
  failureSignatures: 'failure-signatures',
  nightlyExploration: 'nightly-exploration',
  processedComments: 'processed-comment',
  blocks: 'block',
} as const;
const CLAIMED = 'claimed-issue';
const LINEAR = 'linear-pending';
const CHANGELOG = 'last-changelog-release';
const AUTO_MERGE = 'auto-merge-defaulted';
const INTERNAL_REVIEW_SEEDED = 'internal-review-seeded';
const AUTO_DEPLOY = 'auto-deploy';

export function toEntries(state: LocalState): Entry[] {
  const entries: Entry[] = [];
  for (const [field, kind] of Object.entries(RECORDS)) {
    for (const [key, value] of Object.entries(state[field as keyof typeof RECORDS])) entries.push({ kind, key, value });
  }
  for (const n of new Set(state.claimedIssues)) entries.push({ kind: CLAIMED, key: String(n), value: true });
  for (const p of state.linearPending) entries.push({ kind: LINEAR, key: String(p.number), value: p });
  if (state.lastChangelogRelease) entries.push({ kind: CHANGELOG, key: '', value: state.lastChangelogRelease });
  if (state.autoMergeDefaulted) entries.push({ kind: AUTO_MERGE, key: '', value: state.autoMergeDefaulted });
  if (state.internalReviewSeeded) entries.push({ kind: INTERNAL_REVIEW_SEEDED, key: '', value: true });
  if (state.autoDeploy) entries.push({ kind: AUTO_DEPLOY, key: '', value: state.autoDeploy });
  return entries;
}

export function fromEntries(entries: Entry[]): LocalState {
  const state: LocalState = { claimedIssues: [], checksPendingCounts: {}, lastReviewedSha: {}, internalReviewedSha: {}, internalReviewFailed: {}, failureSignatures: {}, nightlyExploration: {}, processedComments: {}, blocks: {}, linearPending: [] };
  const fieldOf = new Map(Object.entries(RECORDS).map(([field, kind]) => [kind as string, field as keyof typeof RECORDS]));
  for (const { kind, key, value } of entries) {
    const field = fieldOf.get(kind);
    if (field) (state[field] as Record<string, unknown>)[key] = value;
    else if (kind === CLAIMED) state.claimedIssues.push(Number(key));
    else if (kind === LINEAR) state.linearPending.push(value as LocalState['linearPending'][number]);
    else if (kind === CHANGELOG) state.lastChangelogRelease = value as LocalState['lastChangelogRelease'];
    else if (kind === AUTO_MERGE) state.autoMergeDefaulted = value as number[];
    else if (kind === INTERNAL_REVIEW_SEEDED) state.internalReviewSeeded = true;
    else if (kind === AUTO_DEPLOY) state.autoDeploy = value as LocalState['autoDeploy'];
  }
  state.claimedIssues.sort((a, b) => a - b);
  state.linearPending.sort((a, b) => a.since.localeCompare(b.since));
  return state;
}

export async function readStateDb(db: Db, repo: string): Promise<LocalState> {
  return fromEntries(await db.selectFrom('repo_state').select(['kind', 'key', 'value']).where('repo', '=', repo).execute());
}

// Called holding the state's lock (withLocalStateLock), like the file: the
// entries gone are deleted, and only the ones whose value changed are
// written (jsonb compares by value, whatever the order of its keys).
export async function writeStateDb(db: Db, repo: string, state: LocalState): Promise<void> {
  const entries = toEntries(state);
  const keep = new Set(entries.map((e) => `${e.kind}\u0000${e.key}`));
  await db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('repo_state').select(['kind', 'key']).where('repo', '=', repo).execute();
    for (const gone of current.filter((e) => !keep.has(`${e.kind}\u0000${e.key}`))) {
      await trx.deleteFrom('repo_state').where('repo', '=', repo).where('kind', '=', gone.kind).where('key', '=', gone.key).execute();
    }
    if (entries.length === 0) return;
    await trx.insertInto('repo_state')
      .values(entries.map((e) => ({ repo, kind: e.kind, key: e.key, value: JSON.stringify(e.value) })))
      .onConflict((oc) => oc.columns(['repo', 'kind', 'key'])
        .doUpdateSet({ value: (eb) => eb.ref('excluded.value'), updated_at: sql<string>`now()` })
        .where(sql<boolean>`repo_state.value is distinct from excluded.value`))
      .execute();
  });
}
