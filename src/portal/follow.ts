import { config, LABEL_AUTO_MERGE, LABEL_PORTAL } from '../core/config.js';
import { addIssueLabel, getIssueState, getPullRequestStatus, listIssuesWithLabel, listPrClosingIssues } from '../core/github.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { getUser } from './accounts.js';
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
//     release.
//   - The team's (and an approved one the team closed without its PR): when
//     the issue closes, the person hears it was solved (completed) or that
//     the team decided not to do it for now (not planned).

export const PR_READY_REPLY = 'Ya hice el cambio. Ahora una persona del equipo lo revisa antes de publicarlo; te aviso por correo cuando esté listo.';
export const DONE_REPLY = '¡Listo! El cambio ya está hecho y sale en la próxima actualización de la aplicación.';
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

async function close(request: PortalRequest, status: 'done' | 'resolved' | 'declined'): Promise<void> {
  const closed = await updateRequest(request.number, (r) => {
    r.status = status;
    const note = status !== 'done' ? r.closeNote?.text : undefined;
    addRoninMessage(r, note && status !== 'done' ? closedReply(status, note) : status === 'done' && r.bug ? FIXED_REPLY : CLOSE[status]);
    addEvent(r, { kind: 'closed', status });
    return r;
  });
  log.info(`portal: el pedido P-${request.number} quedó ${status} (issue #${request.issue?.number})`);
  const user = await getUser(closed.userId);
  if (user) await sendPortalMails(closed, [status === 'done' ? doneMail(closed, user, config.portal.url) : closedMail(closed, user, config.portal.url)]);
}

// How a closed issue ends the request: done as completed (by an approved
// one's merge, or the team's work), or not planned.
async function closedAs(request: PortalRequest): Promise<'done' | 'resolved' | 'declined'> {
  const { stateReason } = await getIssueState(request.issue!.number);
  if (stateReason === 'NOT_PLANNED') return 'declined';
  return RONINS.includes(request.status) ? 'done' : 'resolved';
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
        if (pr.state === 'MERGED') await close(request, 'done');
        else if (pr.state === 'CLOSED') {
          // Closed without merging: whatever PR closes the issue next is the one.
          await updateRequest(request.number, (r) => {
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
          const updated = await updateRequest(request.number, (r) => {
            r.pr = Number(pr);
            addEvent(r, { kind: 'pr', number: r.pr });
            addRoninMessage(r, r.status === 'fixing' ? FIX_READY_REPLY : PR_READY_REPLY);
            return r;
          });
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
