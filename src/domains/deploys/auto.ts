import { config } from '@platform/config/config.js';
import { dayIn } from '@platform/config/timezone.js';
import { log } from '@platform/logger.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { getAutoDeploy, setAutoDeploy } from '@platform/state/local-state.js';
import { recipientsFor } from '@platform/notify/notifications.js';
import { sendMail } from '@platform/notify/notifier.js';
import { addEvent, listRequests, updateRequest, type PortalRequest } from '../portal/requests.js';
import { DeployError, lastRelease, pendingChanges, planRelease, problemText, publishRelease, readRepo, type Problem } from './deploy.js';
import { nextTag, type TagProblem } from './tag-pattern.js';

// The automatic deploy of the portal's requests (#353), a step of the tick
// for each repo with deploy.auto in repos.json: the PRs of requests merged
// on the branch and not in a release yet go out in a release of their own,
// as "Solo lo que elijas" does — cherry-picked onto the last release — on
// a tag of the repo's pattern (tag-pattern.ts). What isn't a request's
// stays for the releases published by hand. A PR that doesn't apply is
// left out of the batch, the rest goes, and its request says why (and the
// team hears it, once). Always a release, never a pre-release: a dev
// already approved what goes in. From there it's a deploy like any other:
// followDeploys follows its workflow and tells the people.

const TAG_PROBLEM: Record<TagProblem, (pattern: string, last: string | null) => string> = {
  'pattern-invalid': (pattern) => `El patrón del tag (${pattern}) no sirve: revísalo en Ajustes → Repos.`,
  'no-base': () => 'El repo no tiene un release anterior: el primero se publica a mano.',
  'base-mismatch': (pattern, last) => `El último release (${last}) no encaja con el patrón del tag (${pattern}): publica uno a mano con ese formato o cambia el patrón.`,
};

// The requests whose merged PR may not be out yet: read before anything
// that costs a fetch or GitHub, so a tick with nothing to deploy costs nothing.
function waiting(requests: PortalRequest[], repo: string): PortalRequest[] {
  return requests.filter((r) => r.repo === repo && r.status === 'done' && r.pr && !r.deployed
    && !(r.events ?? []).some((e) => e.kind === 'deploy' && !e.prerelease && e.state !== 'failed'));
}

async function note(problem: string | null, tag?: string): Promise<void> {
  const before = await getAutoDeploy();
  if (problem && before?.problem !== problem) log.info(`deploy automático de ${activeRepo().productRepo}: ${problem}`);
  if (before?.problem === problem && !tag) return;
  await setAutoDeploy({ at: new Date().toISOString(), problem, ...(tag ? { tag } : {}) });
}

// A PR left out of the batch: on its requests, and to the team, once per base.
async function leftOut(conflict: Extract<Problem, { kind: 'conflict' }>, base: string, requests: PortalRequest[]): Promise<void> {
  const of = requests.filter((r) => r.pr === conflict.pr);
  const fresh = of.filter((r) => !(r.events ?? []).some((e) => e.kind === 'deploy-skipped' && e.base === base));
  if (!fresh.length) return;
  for (const r of fresh) {
    await updateRequest(r.number, (x) => addEvent(x, { kind: 'deploy-skipped', base, files: conflict.files, needs: conflict.needs }));
  }
  const repo = activeRepo().productRepo;
  const text = [
    `El despliegue automático de ${repo} dejó fuera el PR #${conflict.pr} (${fresh.map((r) => `pedido P-${r.number}`).join(', ')}): ${problemText(conflict)}`,
    'El resto de los pedidos sale igual. Este vuelve a intentarse en el próximo lote; si no se aplica solo, se despliega a mano desde Despliegues, con lo que le falta.',
    config.dashboard.url ? `${config.dashboard.url}/despliegues` : null,
  ].filter(Boolean).join('\n\n');
  await sendMail({ to: await recipientsFor(repo, activeRepo(), 'pedido-revisar'), subject: `[ronin] Despliegue automático: el PR #${conflict.pr} quedó fuera`, text })
    .catch((error) => log.error(`deploy automático: no se pudo avisar que el PR #${conflict.pr} quedó fuera`, error));
}

// Inside withActiveRepo. Never throws: what stood in the way is noted for
// Despliegues (getAutoDeploy).
export async function autoDeploy(now = new Date()): Promise<void> {
  const entry = activeRepo();
  const auto = entry.deploy?.auto;
  if (!auto) return;
  try {
    const requests = await listRequests();
    if (!waiting(requests, entry.productRepo).length) {
      // A problem of a batch that went out by hand meanwhile is over.
      if ((await getAutoDeploy())?.problem) await note(null);
      return;
    }
    if (!entry.deploy?.selective) return await note('El despliegue automático necesita «Solo los PRs que se elijan» (deploy.selective).');
    const read = await readRepo();
    const pending = await pendingChanges({}, read);
    let prs = [...new Set(pending.changes.filter((c) => c.pr !== null && c.pedidos.length).map((c) => c.pr!))];
    if (!prs.length) return await note(null);
    const last = lastRelease(read.releases, false)?.tagName ?? null;
    const next = nextTag({ pattern: auto.tag, lastTag: last, day: dayIn(now, config.exploreTimezone), tags: new Set(read.releases.map((r) => r.tagName)) });
    if ('problem' in next) return await note(TAG_PROBLEM[next.problem](auto.tag, last));
    // What doesn't apply goes out of the batch, one at a time, until the
    // rest does (or nothing's left).
    for (;;) {
      const plan = await planRelease({ tag: next.tag, prs, prerelease: false });
      const conflict = plan.problems.find((p): p is Extract<Problem, { kind: 'conflict' }> => p.kind === 'conflict');
      if (conflict?.pr && plan.base) {
        await leftOut(conflict, plan.base.tag, requests);
        prs = prs.filter((pr) => pr !== conflict.pr);
        if (!prs.length) return await note(`Ningún PR de pedidos se aplica sobre ${plan.base.tag}: quedan para un despliegue a mano.`);
        continue;
      }
      if (plan.problems.length) return await note(problemText(plan.problems[0]));
      break;
    }
    const record = await publishRelease({ tag: next.tag, prs, prerelease: false, by: config.githubLogin });
    log.info(`deploy automático: ${entry.productRepo} publicó ${record.tag} con ${record.pedidos.map((n) => `P-${n}`).join(', ')}`);
    await note(null, record.tag);
  } catch (error) {
    // Another deploy of the repo publishing right now: the next tick tries.
    if (error instanceof DeployError && /Ya se está publicando/.test(error.message)) return;
    log.error(`deploy automático: falló en ${entry.productRepo}`, error);
    await note(`Falló el último intento: ${(error as Error).message.split('\n')[0].slice(0, 300)}`).catch(() => {});
  }
}
