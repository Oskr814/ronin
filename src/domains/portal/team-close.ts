import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import { closedReply } from './follow.js';
import { closedMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addEvent, addRoninMessage, RequestError, TEAM_CLOSABLE, updateRequest, type PortalRequest } from './requests.js';

// Someone of the team closes a request from the tablero (#404) while it
// has no issue (TEAM_CLOSABLE): waiting on the person, answered, or while
// ronin reads it. It ends 'declined' with the reason, which the person gets
// in those words, in the portal and by mail, as when the team closes a PR
// from the tablero. A worker still running on it finishes and leaves it as
// it is (updateUnlessClosed).

const MAX_REASON = 2000;

export function parseCloseReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw new RequestError('Escribe el motivo: le llega a la persona.');
  if (reason.length > MAX_REASON) throw new RequestError(`El motivo puede tener hasta ${MAX_REASON} caracteres.`);
  return reason;
}

export async function teamClose(n: number, input: { reason: string; by: string }, now = new Date()): Promise<PortalRequest> {
  const closed = await updateRequest(n, (r) => {
    if (!TEAM_CLOSABLE.includes(r.status) || r.issue) throw new RequestError('Este pedido ya no se puede cerrar desde aquí.');
    r.status = 'declined';
    r.closeNote = { text: input.reason, by: input.by, at: now.toISOString() };
    delete r.worker;
    addRoninMessage(r, closedReply('declined', input.reason), now);
    addEvent(r, { kind: 'closed', status: 'declined', by: input.by }, now);
    return r;
  });
  log.info(`portal: ${input.by} cerró el pedido P-${n} desde el tablero`);
  const user = await getUser(closed.userId);
  if (user) await sendPortalMails(closed, [closedMail(closed, user, config.portal.url)]);
  return closed;
}
