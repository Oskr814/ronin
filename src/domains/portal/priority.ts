import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import { teamWroteMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { activePriority, addEvent, nextMessageId, PRIORITY_IMPACTS, RequestError, updateRequest, type PortalRequest, type Priority, type PriorityImpact } from './requests.js';

// A request approved as prioritario: the person says why it can't wait, it
// goes first in the tablero and in their list, and the team hears of it by
// its own email (notify.ts). Up to portal.priorityDailyLimit a day per
// person. The team can take it away with a reason the person gets: it goes
// on as a normal request.

export const MAX_PRIORITY_REASON = 500;

// What the person sent approving it; nothing when they didn't mark it.
export function parsePriority(value: unknown, today: string): Omit<Priority, 'at'> | undefined {
  if (value === undefined || value === null) return undefined;
  const given = typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const impact = given.impact as PriorityImpact;
  if (!PRIORITY_IMPACTS.includes(impact)) throw new RequestError('Elige por qué no puede esperar.');
  const reason = typeof given.reason === 'string' ? given.reason.trim() : '';
  if (!reason) throw new RequestError('Cuéntale al equipo qué pasa si no está a tiempo.');
  if (reason.length > MAX_PRIORITY_REASON) throw new RequestError(`El motivo puede tener hasta ${MAX_PRIORITY_REASON} caracteres.`);
  if (impact !== 'deadline') return { impact, reason };
  const deadline = typeof given.deadline === 'string' ? given.deadline : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline))) throw new RequestError('Elige la fecha límite.');
  if (deadline < today) throw new RequestError('La fecha límite ya pasó.');
  return { impact, reason, deadline };
}

// The team takes it away (from the tablero): it stays as a normal request,
// and the person gets the reason as a message of the team, in the portal
// and by mail. What they used of the day isn't given back.
export async function removePriority(n: number, input: { reason: string; by: string }, now = new Date()): Promise<PortalRequest> {
  const reason = input.reason.trim();
  if (!reason) throw new RequestError('Escribe el motivo: le llega a la persona.');
  if (reason.length > MAX_PRIORITY_REASON) throw new RequestError(`El motivo puede tener hasta ${MAX_PRIORITY_REASON} caracteres.`);
  const removed = await updateRequest(n, (r) => {
    const p = activePriority(r);
    if (!p) throw new RequestError('Este pedido ya no es prioritario.');
    const at = now.toISOString();
    p.removed = { by: input.by, reason, at };
    r.messages.push({ id: nextMessageId(r), from: 'team', by: input.by, text: `${reason}\n\nLe quitamos la prioridad: el pedido sigue, en el orden normal.`, images: [], at });
    addEvent(r, { kind: 'priority-removed', by: input.by }, now);
    return r;
  });
  log.info(`portal: ${input.by} le quitó la prioridad al pedido P-${n}`);
  const user = await getUser(removed.userId);
  if (user) await sendPortalMails(removed, [teamWroteMail(removed, user, config.portal.url, removed.messages.at(-1)!.text, 0)]);
  return removed;
}
