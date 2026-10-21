import { loadRepos } from '../../core/repos.js';
import { sees, type Access } from './access.js';
import { listRuns } from './dashboard-data.js';

// What a dashboard session sees (#106): only the repos access.ts lets it,
// and their runs. Every read of the dashboard's routes goes through here.

export async function visibleRepos(access: Access) {
  return (await loadRepos()).filter((entry) => sees(access, entry.productRepo));
}

export async function visibleRuns(access: Access, days: number) {
  return (await listRuns(days)).filter((run) => sees(access, run.repo));
}
