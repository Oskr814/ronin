import { join } from 'node:path';
import { config } from '../core/config.js';
import { readJson, withJson } from '../portal/json-store.js';

// The deploys ronin published (#158): GitHub has the releases, but only this
// says what each one carried (which PRs, which portal requests), who
// published it and how its workflow ended. The only copy, like the portal's.

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

// Plenty for the dashboard's history; past it, the oldest go.
export const MAX_DEPLOYS = 500;

const path = () => join(config.deploys.dataDir, 'deploys.json');
const empty = (): DeployFile => ({ deploys: [] });

// Newest first.
export async function listDeploys(repo?: string): Promise<DeployRecord[]> {
  const { deploys } = await readJson(path(), empty);
  return deploys.filter((d) => !repo || d.repo === repo).sort((a, b) => b.at.localeCompare(a.at));
}

export function addDeploy(record: DeployRecord): Promise<void> {
  return withJson(path(), empty, (file) => {
    file.deploys.push(record);
    if (file.deploys.length > MAX_DEPLOYS) file.deploys.splice(0, file.deploys.length - MAX_DEPLOYS);
  });
}

export function updateDeploy(repo: string, tag: string, fn: (record: DeployRecord) => void): Promise<DeployRecord | undefined> {
  return withJson(path(), empty, (file) => {
    const record = file.deploys.find((d) => d.repo === repo && d.tag === tag);
    if (record) fn(record);
    return record;
  });
}
