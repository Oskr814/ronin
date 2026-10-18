import { config } from '../core/config.js';
import { listTagRuns, type WorkflowRun } from '../core/github.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { getUser } from '../portal/accounts.js';
import { deployedMail } from '../portal/mail.js';
import { sendPortalMails } from '../portal/notify.js';
import { addEvent, updateRequest } from '../portal/requests.js';
import { listDeploys, updateDeploy, type DeployRecord } from './store.js';

// The tick and the workflow_run webhook (#158), inside withActiveRepo:
// follows the workflow runs of each release ronin published, until they
// end. Deployed, the portal requests it carried get it in their activity,
// and their people hear their change is in the app — not for a pre-release,
// which goes somewhere else (QA).

// No run of the tag by then: the repo's workflow doesn't run on it.
export const NO_RUNS_AFTER_MS = 2 * 60 * 60_000;

const OK = ['success', 'skipped', 'neutral'];

export function deployState(runs: WorkflowRun[], ageMs: number): DeployRecord['state'] {
  if (!runs.length) return ageMs > NO_RUNS_AFTER_MS ? 'unknown' : 'running';
  if (runs.some((run) => run.status !== 'completed')) return 'running';
  return runs.every((run) => OK.includes(run.conclusion)) ? 'deployed' : 'failed';
}

async function tellRequests(record: DeployRecord, state: 'deployed' | 'failed'): Promise<void> {
  for (const n of record.pedidos) {
    try {
      const request = await updateRequest(n, (r) => {
        addEvent(r, { kind: 'deploy', tag: record.tag, state, prerelease: record.prerelease });
        if (state === 'deployed' && !record.prerelease) r.deployed = { tag: record.tag, at: record.endedAt ?? new Date().toISOString() };
        return r;
      });
      if (state !== 'deployed' || record.prerelease) continue;
      const user = await getUser(request.userId);
      if (user) await sendPortalMails(request, [deployedMail(request, user, config.portal.url)]);
    } catch (error) {
      log.error(`deploy: no se pudo avisar ${record.tag} al pedido P-${n}`, error);
    }
  }
}

export async function followDeploys(now = Date.now()): Promise<void> {
  const repo = activeRepo().productRepo;
  for (const record of (await listDeploys(repo)).filter((d) => d.state === 'running')) {
    try {
      const runs = (await listTagRuns(record.tag)).filter((run) => run.headSha === record.sha);
      const state = deployState(runs, now - Date.parse(record.at));
      if (state === 'running') continue;
      const ended = await updateDeploy(repo, record.tag, (r) => {
        r.state = state;
        r.endedAt = new Date(now).toISOString();
        r.runs = runs.map((run) => ({ name: run.workflowName, conclusion: run.conclusion, url: run.url }));
      });
      log.info(`deploy: ${record.tag} de ${repo} terminó: ${state}`);
      if (ended && state !== 'unknown') await tellRequests(ended, state);
    } catch (error) {
      log.error(`deploy: no se pudo seguir el workflow de ${record.tag}`, error);
    }
  }
}
