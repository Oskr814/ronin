import { config, LABEL_AUTO_MERGE, LABEL_PORTAL } from '@platform/config/config.js';
import { addIssueLabel, getIssueState, getPrFileNames, getPullRequestStatus, listIssuesWithLabel, listPrClosingIssues } from '@platform/github/github.js';
import { approvePr } from '@platform/github/github-as-user.js';
import { log } from '@platform/logger.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { saveResolved } from '../knowledge/knowledge.js';
import { getUser } from './accounts.js';
import { deciderToken, dropDeciderToken } from './dev-decision.js';
import { closedMail, doneMail, teamPrMail } from './mail.js';
import { sendPortalMails, teamTo } from './notify.js';
import { addEvent, addRoninMessage, listRequests, RONINS, updateRequest, type PortalRequest, type RequestStatus } from './requests.js';

// The tick (and the webhooks of a PR opened or closed and of an issue
// closed), inside withActiveRepo: follows the issues this repo's portal
// requests became (#114, issue.ts).
//   - Approved, or a reported error's small fix (#137): the PR ronin opened
//     gets ronin:auto-merge — it merges once
//     a dev approves it and CI is green (auto-merge.ts) — and the team hears
//     it waits for them; merged, the person hears it goes out in the next
//     release. When the dev who decided chose to deploy it (#353), ronin
//     approves it as them right away (their token, sealed until then).
//   - The team's (and an approved one the team closed without its PR): when
//     the issue closes, the person hears it was solved (completed) or that
//     the team decided not to do it for now (not planned).

export const PR_READY_REPLY = 'Ya hice el cambio. Ahora una persona del equipo lo revisa antes de publicarlo; te aviso por correo cuando esté listo.';
export const DONE_REPLY = '¡Listo! El cambio ya está hecho y sale en la próxima actualización de la aplicación.';
export const DEPLOY_READY_REPLY = 'Ya hice el cambio. Sale apenas pasen las pruebas automáticas; te aviso por correo cuando esté listo.';
export const FIX_DEPLOY_REPLY = 'Ya corregí el error. El arreglo sale apenas pasen las pruebas automáticas; te aviso por correo cuando esté listo.';
export const FIX_READY_REPLY = 'Ya corregí el error. Ahora una persona del equipo revisa el arreglo antes de publicarlo; te aviso por correo cuando esté listo.';
export const FIXED_REPLY = '¡Listo! El error ya está corregido y el arreglo sale en la próxima actualización de la aplicación.';
export const RESOLVED_REPLY = 'El equipo de desarrollo resolvió tu pedido. Si era un cambio en la aplicación, sale en una próxima actualización.';
export const DECLINED_REPLY = 'El equipo de desarrollo revisó tu pedido y decidió no hacerlo por ahora. Si necesitas algo más, puedes enviar un pedido nuevo.';

const FOLLOWED: RequestStatus[] = [...RONINS, 'big'];

const CLOSE: Record<'done' | 'resolved' | 'declined', string> = { done: DONE_REPLY, resolved: RESOLVED_REPLY, declined: DECLINED_REPLY };

// With the team's reason, it goes in the middle, in their words.
export function closedReply(status: 'resolved' | 'declined', note: string): string {
  return status === 'declined'
    ? `El equipo de desarrollo revisó tu pedido y decidió no hacerlo por ahora:\n\n${note}\n\nSi necesitas algo más, puedes enviar un pedido nuevo.`
    : `El equipo de desarrollo resolvió tu pedido:\n\n${note}`;
}

// The reason written when closing the PR from the tablero, kept on the open
// request of that issue or PR until its issue closes. Before the issue is
// closed, so it's there whichever sees it closed first (a webhook, the tick).
// Null when no open request is behind it.
export async function noteClosing(repo: string, ref: { issue?: number; pr?: number }, text: string, by: string): Promise<number | null> {
  const request = (await listRequests()).find((r) => r.repo === repo && FOLLOWED.includes(r.status) && ((ref.issue !== undefined && r.issue?.number === ref.issue) || (ref.pr !== undefined && r.pr === ref.pr)));
  if (!request) return null;
  await updateRequest(request.number, (r) => {
    r.closeNote = { text, by, at: new Date().toISOString() };
  });
  return request.number;
}

// Takes it back, when closing failed: the request stays open.
export async function dropCloseNote(n: number): Promise<void> {
  await updateRequest(n, (r) => {
    delete r.closeNote;
  });
}

// The pass reads every request at its start and GitHub takes seconds: one
// that changed meanwhile (handed back to ronin, cancelled, its issue
// unlinked) is no longer what the pass saw, and is left alone (#402).
const unchanged = (r: PortalRequest, seen: PortalRequest) => r.status === seen.status && r.issue?.number === seen.issue?.number && r.pr === seen.pr;

async function close(request: PortalRequest, status: 'done' | 'resolved' | 'declined'): Promise<void> {
  const closed = await updateRequest(request.number, (r) => {
    if (!unchanged(r, request)) return undefined;
    r.status = status;
    const note = status !== 'done' ? r.closeNote?.text : undefined;
    addRoninMessage(r, note && status !== 'done' ? closedReply(status, note) : status === 'done' && r.bug ? FIXED_REPLY : CLOSE[status]);
    addEvent(r, { kind: 'closed', status });
    return r;
  });
  if (!closed) {
    log.info(`portal: el pedido P-${request.number} cambió mientras se seguía su issue #${request.issue?.number}; no lo cierro`);
    return;
  }
  log.info(`portal: el pedido P-${request.number} quedó ${status} (issue #${request.issue?.number})`);
  const user = await getUser(closed.userId);
  if (user) await sendPortalMails(closed, [status === 'done' ? doneMail(closed, user, config.portal.url) : closedMail(closed, user, config.portal.url)]);
}

// Its PR merged: the app's bitácora notes what it was about and the files
// it touched (#412). A failure only costs that line.
async function noteResolved(request: PortalRequest, pr: number): Promise<void> {
  try {
    await saveResolved(request.app, { request: request.number, summary: request.title, files: await getPrFileNames(pr), pr, mergedAt: new Date().toISOString() });
  } catch (error) {
    log.error(`portal: no se pudo anotar en la bitácora el pedido P-${request.number}`, error);
  }
}

// How a closed issue ends the request: done as completed (by an approved
// one's merge, or the team's work), or not planned.
async function closedAs(request: PortalRequest): Promise<'done' | 'resolved' | 'declined'> {
  const { stateReason } = await getIssueState(request.issue!.number);
  if (stateReason === 'NOT_PLANNED') return 'declined';
  return RONINS.includes(request.status) ? 'done' : 'resolved';
}


// The PR of a request a dev chose to deploy (#353), approved as them: then
// auto-merge merges it on green CI. Null when nobody chose that; false when
// their token no longer works (they logged out, it was revoked): the PR
// waits for an approval like any other. The token goes either way.
async function approveAsDecider(request: PortalRequest, pr: number): Promise<boolean | null> {
  if (request.devDecision?.kind !== 'deploy') return null;
  const token = deciderToken(request);
  let ok = false;
  if (token) {
    try {
      await approvePr(token, activeRepo().productRepo, pr, `Aprobado desde el tablero al decidir el pedido P-${request.number} del portal (Aprobar y desplegar).`);
      ok = true;
      log.info(`portal: el PR #${pr} del pedido P-${request.number} quedó aprobado a nombre de ${request.devDecision.by}`);
    } catch (error) {
      log.error(`portal: no se pudo aprobar el PR #${pr} a nombre de ${request.devDecision.by}`, error);
    }
  }
  await dropDeciderToken(request.number);
  return ok;
}

export async function followPortalIssues(): Promise<void> {
  const repo = activeRepo().productRepo;
  const followed = (await listRequests()).filter((r) => r.repo === repo && FOLLOWED.includes(r.status) && r.issue);
  if (!followed.length) return;
  // One call each per pass, only when needed: the open PRs and what they
  // close, and which ronin:portal issues are closed.
  let closing: Record<number, number[]> | undefined;
  let closedIssues: Set<number> | undefined;
  const isClosed = async (n: number) => {
    closedIssues ??= new Set((await listIssuesWithLabel(LABEL_PORTAL)).filter((i) => i.state.toUpperCase() === 'CLOSED').map((i) => i.number));
    return closedIssues.has(n);
  };
  for (const request of followed) {
    const issue = request.issue!.number;
    try {
      if (RONINS.includes(request.status) && request.pr) {
        const pr = await getPullRequestStatus(request.pr);
        if (pr.state === 'MERGED') {
          await close(request, 'done');
          await noteResolved(request, request.pr);
        }
        else if (pr.state === 'CLOSED') {
          // Closed without merging: whatever PR closes the issue next is the one.
          await updateRequest(request.number, (r) => {
            if (!unchanged(r, request)) return;
            addEvent(r, { kind: 'pr-closed', number: request.pr! });
            delete r.pr;
          });
          log.info(`portal: el PR #${request.pr} del pedido P-${request.number} se cerró sin merge`);
        }
        continue;
      }
      if (RONINS.includes(request.status)) {
        closing ??= await listPrClosingIssues();
        const pr = Object.entries(closing).find(([, issues]) => issues.includes(issue))?.[0];
        if (pr) {
          await addIssueLabel(Number(pr), LABEL_AUTO_MERGE);
          const approved = await approveAsDecider(request, Number(pr));
          const updated = await updateRequest(request.number, (r) => {
            if (!unchanged(r, request)) return undefined;
            r.pr = Number(pr);
            addEvent(r, { kind: 'pr', number: r.pr });
            if (approved !== null) addEvent(r, { kind: 'pr-approved', number: r.pr, by: r.devDecision!.by, ok: approved });
            addRoninMessage(r, approved ? (r.status === 'fixing' ? FIX_DEPLOY_REPLY : DEPLOY_READY_REPLY) : r.status === 'fixing' ? FIX_READY_REPLY : PR_READY_REPLY);
            return r;
          });
          if (!updated) continue;
          log.info(`portal: el pedido P-${request.number} tiene el PR #${pr}, con ${LABEL_AUTO_MERGE}`);
          await sendPortalMails(updated, [{ ...teamPrMail(updated, await getUser(updated.userId), await teamTo('pedido-revisar'), `https://github.com/${repo}/pull/${pr}`), team: true }]);
          continue;
        }
      }
      if (await isClosed(issue)) await close(request, await closedAs(request));
    } catch (error) {
      log.error(`portal: no se pudo seguir el pedido P-${request.number} (issue #${issue})`, error);
    }
  }
}
