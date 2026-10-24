import { config } from '@platform/config/config.js';
import { closeIssue, commentOnIssue } from '@platform/github/github-as-user.js';
import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import { closedReply, dropCloseNote } from './follow.js';
import { closedMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addEvent, addRoninMessage, getRequest, RequestError, TEAM_CLOSABLE, updateRequest, type PortalRequest } from './requests.js';

// Someone of the team closes a request from the tablero (#404) while it
// has no issue (TEAM_CLOSABLE): waiting on the person, answered, or while
// ronin reads it. It ends 'declined' with the reason, which the person gets
// in those words, in the portal and by mail, as when the team closes a PR
// from the tablero. A worker still running on it finishes and leaves it as
// it is (updateUnlessClosed).
// A big one with its issue, the team's, closes too: its issue closes as not
// planned, as whoever closes it, with the reason in a comment. The reason is
// kept before GitHub hears of it, so a webhook of the closed issue that comes
// first (follow.ts) declines it with those same words.

const MAX_REASON = 2000;

export function parseCloseReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw new RequestError('Escribe el motivo: le llega a la persona.');
  if (reason.length > MAX_REASON) throw new RequestError(`El motivo puede tener hasta ${MAX_REASON} caracteres.`);
  return reason;
}

const closableBig = (r: PortalRequest) => r.status === 'big' && Boolean(r.issue);

export async function teamClose(n: number, input: { reason: string; by: string; token?: string }, now = new Date()): Promise<PortalRequest> {
  const seen = await getRequest(n);
  const big = seen !== undefined && closableBig(seen);
  if (big) await closeItsIssue(seen, input, now);
  const closed = await updateRequest(n, (r) => {
    // Its issue's webhook declined it already, with the reason.
    if (big && r.status === 'declined') return undefined;
    if (big ? !closableBig(r) : !TEAM_CLOSABLE.includes(r.status) || r.issue) throw new RequestError('Este pedido ya no se puede cerrar desde aquí.');
    r.status = 'declined';
    r.closeNote = { text: input.reason, by: input.by, at: now.toISOString() };
    delete r.worker;
    addRoninMessage(r, closedReply('declined', input.reason), now);
    addEvent(r, { kind: 'closed', status: 'declined', by: input.by }, now);
    return r;
  });
  if (!closed) return (await getRequest(n))!;
  log.info(`portal: ${input.by} cerró el pedido P-${n} desde el tablero`);
  const user = await getUser(closed.userId);
  if (user) await sendPortalMails(closed, [closedMail(closed, user, config.portal.url)]);
  return closed;
}

// The issue of a big one: the reason kept first, then the comment and the
// close as the person. Failing, the reason goes and it stays open.
async function closeItsIssue(r: PortalRequest, input: { reason: string; by: string; token?: string }, now: Date): Promise<void> {
  if (!input.token) throw new RequestError('Hace falta tu sesión de GitHub para cerrar su issue.');
  await updateRequest(r.number, (x) => {
    x.closeNote = { text: input.reason, by: input.by, at: now.toISOString() };
  });
  try {
    await commentOnIssue(input.token, r.repo, r.issue!.number, `No se hará: ${input.by} cerró el pedido P-${r.number} del portal desde el tablero. Le llega a la persona con estas palabras:\n\n${input.reason.split('\n').map((l) => `> ${l}`).join('\n')}`);
    await closeIssue(input.token, r.repo, r.issue!.number);
  } catch (e) {
    await dropCloseNote(r.number).catch((err) => log.error(`portal: no se pudo quitar el motivo del pedido P-${r.number}`, err));
    throw e;
  }
}
