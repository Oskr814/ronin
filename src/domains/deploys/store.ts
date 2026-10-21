import { join } from 'node:path';
import type { Selectable } from 'kysely';
import { config } from '../../platform/config/config.js';
import { onStore, requireDb } from '../../platform/store/backend.js';
import type { DeploysTable } from '../../platform/db/schema.js';
import { readJson, withJson } from '../../platform/fs/atomic-json.js';

// The deploys ronin published (#158): GitHub has the releases, but only this
// says what each one carried (which PRs, which portal requests), who
// published it and how its workflow ended. The only copy, like the portal's.
//
// In Postgres with DATABASE_URL (#235, stage 2: table deploys), else in
// <DEPLOYS_DATA_DIR>/deploys.json as before.

export interface DeployRecord {
  repo: string;
  tag: string;
  prerelease: boolean;
  // Everything on the branch, or only the PRs someone picked (cherry-picked
  // onto the last release).
  mode: 'all' | 'pick';
  // The release it was compared with: what it adds is what came after.
  base: string | null;
  sha: string;
  url: string;
  changes: Array<{ pr: number | null; subject: string }>;
  pedidos: number[];
  by: string;
  at: string;
  // Its workflow runs: still going, all ended well, one failed, or none
  // showed up in time (the repo's workflow doesn't run on this tag).
  state: 'running' | 'deployed' | 'failed' | 'unknown';
  runs?: Array<{ name: string; conclusion: string; url: string }>;
  endedAt?: string;
  // The tag went up but the release couldn't be created.
  releaseError?: string;
}

interface DeployFile {
  deploys: DeployRecord[];
}

// Plenty for the dashboard's history; past it, the oldest go. Only the
// file has a cap: the table keeps them all.
export const MAX_DEPLOYS = 500;

const path = () => join(config.deploys.dataDir, 'deploys.json');
const empty = (): DeployFile => ({ deploys: [] });

const fromRow = (r: Selectable<DeploysTable>): DeployRecord => ({
  repo: r.repo,
  tag: r.tag,
  prerelease: r.prerelease,
  mode: r.mode as DeployRecord['mode'],
  base: r.base,
  sha: r.sha,
  url: r.url,
  changes: r.changes as DeployRecord['changes'],
  pedidos: r.pedidos,
  by: r.by,
  at: r.at.toISOString(),
  state: r.state as DeployRecord['state'],
  ...(r.runs ? { runs: r.runs as DeployRecord['runs'] } : {}),
  ...(r.ended_at ? { endedAt: r.ended_at.toISOString() } : {}),
  ...(r.release_error ? { releaseError: r.release_error } : {}),
});

const toRow = (d: DeployRecord) => ({
  repo: d.repo,
  tag: d.tag,
  prerelease: d.prerelease,
  mode: d.mode,
  base: d.base,
  sha: d.sha,
  url: d.url,
  changes: JSON.stringify(d.changes),
  pedidos: d.pedidos,
  by: d.by,
  at: d.at,
  state: d.state,
  runs: d.runs ? JSON.stringify(d.runs) : null,
  ended_at: d.endedAt ?? null,
  release_error: d.releaseError ?? null,
});

// Newest first.
export function listDeploys(repo?: string): Promise<DeployRecord[]> {
  return onStore({
    db: async (db) => {
      let query = db.selectFrom('deploys').selectAll().orderBy('at', 'desc');
      if (repo) query = query.where('repo', '=', repo);
      return (await query.execute()).map(fromRow);
    },
    files: async () => {
      const { deploys } = await readJson(path(), empty);
      return deploys.filter((d) => !repo || d.repo === repo).sort((a, b) => b.at.localeCompare(a.at));
    },
  });
}

export function addDeploy(record: DeployRecord): Promise<void> {
  return onStore({
    db: async (db) => {
      await db.insertInto('deploys').values(toRow(record)).execute();
    },
    files: () => withJson(path(), empty, (file) => {
      file.deploys.push(record);
      if (file.deploys.length > MAX_DEPLOYS) file.deploys.splice(0, file.deploys.length - MAX_DEPLOYS);
    }),
  });
}

// Changes one through `fn`, taking turns with anyone else changing it (the
// tick and the dashboard both follow a running deploy).
export function updateDeploy(repo: string, tag: string, fn: (record: DeployRecord) => void): Promise<DeployRecord | undefined> {
  return onStore({
    db: (db) => db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('deploys').selectAll().where('repo', '=', repo).where('tag', '=', tag).forUpdate().executeTakeFirst();
      if (!row) return undefined;
      const record = fromRow(row);
      fn(record);
      const { repo: _r, tag: _t, ...rest } = toRow(record);
      await trx.updateTable('deploys').set(rest).where('repo', '=', repo).where('tag', '=', tag).execute();
      return record;
    }),
    files: () => withJson(path(), empty, (file) => {
      const record = file.deploys.find((d) => d.repo === repo && d.tag === tag);
      if (record) fn(record);
      return record;
    }),
  });
}

// For the import (scripts/db-import-despliegues.ts): every one in the file.
export async function fileDeploys(dataDir = config.deploys.dataDir): Promise<DeployRecord[]> {
  return (await readJson(join(dataDir, 'deploys.json'), empty)).deploys;
}

// Writes one as it is, over the one with its repo and tag (the import).
export async function putDeploy(record: DeployRecord): Promise<void> {
  const row = toRow(record);
  const { repo: _r, tag: _t, ...rest } = row;
  await requireDb().insertInto('deploys').values(row).onConflict((oc) => oc.columns(['repo', 'tag']).doUpdateSet(rest)).execute();
}

