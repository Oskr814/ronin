import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import { expiredMail, reminderMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addEvent, addRoninMessage, EXPIRING, listRequests, updateRequest, type PortalRequest } from './requests.js';

// A request waiting on the person doesn't wait forever (#404). The clock
// runs from ronin's last message, the one that left it waiting: a question,
// the interview's form, its summary, the prototype. The person writing,
// approving it or asking for an adjustment takes it out of the wait; ronin
// asking again starts a new one.
//   - PORTAL_REMIND_HOURS (12) without an answer: a reminder by mail, one per
//     wait, saying when it's cancelled.
//   - PORTAL_EXPIRE_HOURS (24): cancelled, with an 'expired' event, and a
//     message and a mail that say why.
// 'answered' (ronin answered and nothing is pending) closes at the same
// hours, with no reminder: nobody waits for anything. The tick checks it
// every pass, so both arrive up to a pass late. A reminder always gives
// the person the hours it promised: one sent late (a request that was
// already waiting when this shipped, a tick that didn't run) pushes the
// cancellation back.

export const expiredReply = (hours: number) => `Cancelamos este pedido porque no tuvimos respuesta en ${hours} horas. Si todavía lo necesitas, puedes enviar uno nuevo.`;
export const EXPIRED_ANSWERED_REPLY = 'Cerramos este pedido. Si necesitas algo más, puedes enviar uno nuevo.';

const HOUR = 3600_000;

// When its wait started: ronin's last message, while it waits on the person.
export function waitingSince(r: Pick<PortalRequest, 'status' | 'messages' | 'updatedAt'>): Date | null {
  if (!EXPIRING.includes(r.status)) return null;
  return new Date(r.messages.filter((m) => m.from === 'ronin').at(-1)?.at ?? r.updatedAt);
}

export interface Expiry {
  since: Date;
  // When the reminder goes (none for 'answered', or when it would come at
  // or after the cancellation), and when it went, in this wait.
  remindAt: Date | null;
  remindedAt: Date | null;
  expiresAt: Date;
}

export function expiry(r: PortalRequest, now = new Date(), hours = { remind: config.portal.remindHours, expire: config.portal.expireHours }): Expiry | null {
  const since = waitingSince(r);
  if (!since) return null;
  const due = new Date(since.getTime() + hours.expire * HOUR);
  if (r.status === 'answered' || hours.remind >= hours.expire) return { since, remindAt: null, remindedAt: null, expiresAt: due };
  const remindAt = new Date(since.getTime() + hours.remind * HOUR);
  const reminded = r.events?.filter((e) => e.kind === 'reminded' && Date.parse(e.at) >= since.getTime()).at(-1);
  const remindedAt = reminded ? new Date(reminded.at) : null;
  // The hours the reminder promised, from when it went (or would go now).
  const promised = (remindedAt ?? new Date(Math.max(now.getTime(), remindAt.getTime()))).getTime() + (hours.expire - hours.remind) * HOUR;
  return { since, remindAt, remindedAt, expiresAt: new Date(Math.max(due.getTime(), promised)) };
}

// Still the wait the pass saw: nobody answered, ronin didn't ask again.
const sameWait = (r: PortalRequest, seen: Expiry) => waitingSince(r)?.getTime() === seen.since.getTime();

// The tick, once per pass across every repo.
export async function expirePortalRequests(now = new Date()): Promise<void> {
  for (const request of await listRequests()) {
    const seen = expiry(request, now);
    if (!seen) continue;
    try {
      if (now >= seen.expiresAt) await expire(request.number, seen, now);
      else if (seen.remindAt && !seen.remindedAt && now >= seen.remindAt) await remind(request.number, seen, now);
    } catch (error) {
      log.error(`portal: no se pudo revisar el vencimiento del pedido P-${request.number}`, error);
    }
  }
}

async function remind(n: number, seen: Expiry, now: Date): Promise<void> {
  const reminded = await updateRequest(n, (r) => {
    if (!sameWait(r, seen)) return undefined;
    addEvent(r, { kind: 'reminded' }, now);
    return r;
  });
  if (!reminded) return;
  const user = await getUser(reminded.userId);
  log.info(`portal: recordatorio a la persona del pedido P-${n}`);
  if (user) await sendPortalMails(reminded, [reminderMail(reminded, user, config.portal.url, expiry(reminded, now)!.expiresAt, config.exploreTimezone)]);
}

async function expire(n: number, seen: Expiry, now: Date): Promise<void> {
  const hours = config.portal.expireHours;
  let answered = false;
  const expired = await updateRequest(n, (r) => {
    if (!sameWait(r, seen)) return undefined;
    answered = r.status === 'answered';
    r.status = 'cancelled';
    delete r.worker;
    addEvent(r, { kind: 'expired', ...(answered ? { answered: true as const } : {}) }, now);
    addRoninMessage(r, answered ? EXPIRED_ANSWERED_REPLY : expiredReply(hours), now);
    return r;
  });
  if (!expired) return;
  log.info(`portal: el pedido P-${n} venció ${answered ? 'después de la respuesta de ronin' : 'sin respuesta de la persona'}`);
  const user = await getUser(expired.userId);
  if (user) await sendPortalMails(expired, [expiredMail(expired, user, config.portal.url, hours, answered)]);
}
