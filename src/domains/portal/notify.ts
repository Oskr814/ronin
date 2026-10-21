import { readFile } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { recipientsFor, type NotifyEvent } from '@platform/notify/notifications.js';
import { sendMail, type Mail } from '@platform/notify/notifier.js';
import type { PortalUser } from './accounts.js';
import { bigRequestMail, PORTAL_FROM_NAME, teamRequestMail } from './mail.js';
import { noteEvent, patchOf, prototypePatchPath, requestDir, type PortalRequest } from './requests.js';

// Sends a request's emails and logs the ones that fail: a lost email never
// holds a request back. Each one, sent or not, goes to the request's
// activity (#132).
export async function sendPortalMails(request: PortalRequest, mails: Array<Mail | undefined>): Promise<void> {
  const sent = mails.filter((m): m is Mail => Boolean(m));
  const results = await Promise.allSettled(sent.map((m) => sendMail(m, PORTAL_FROM_NAME)));
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') log.error(`portal: no se pudo enviar un correo del pedido P-${request.number}`, result.reason);
    await noteEvent(request.number, { kind: 'mail', to: sent[i].team ? 'team' : 'person', subject: sent[i].subject, ok: result.status === 'fulfilled' });
  }
}

// One mail about several requests (a release that carried them all): sent
// once, and noted on each.
export async function sendRequestsMail(requests: PortalRequest[], mail: Mail): Promise<void> {
  const ok = await sendMail(mail, PORTAL_FROM_NAME).then(() => true, (error) => {
    log.error(`portal: no se pudo enviar un correo de los pedidos ${requests.map((r) => `P-${r.number}`).join(', ')}`, error);
    return false;
  });
  for (const request of requests) await noteEvent(request.number, { kind: 'mail', to: 'person', subject: mail.subject, ok });
}

// Inside withActiveRepo: who of the request's repo's team chose that email in
// Ajustes → Notificaciones (#174), never another repo's; until they choose,
// its portal.notifyTo in repos.json; NOTIFY_TO when nobody (platform/notify/notifications.ts).
export const teamTo = (event: NotifyEvent) => recipientsFor(activeRepo().productRepo, activeRepo(), event);

// To the dev team, with its issue and the last prototype's diff (or a
// reported error's reproduction's) when there is one.
export async function teamMail(request: PortalRequest, user: PortalUser | undefined): Promise<Mail> {
  const file = patchOf(request);
  const patch = file ? await readFile(prototypePatchPath(request.number, file), 'utf8').catch(() => undefined) : undefined;
  return { ...teamRequestMail(request, user, await teamTo('pedido-equipo'), requestDir(request.number), patch), team: true };
}

// A request the team takes now: the person hears right away; the team, with
// the link, once its issue is open (issue.ts).
export async function handOverMail(request: PortalRequest, user: PortalUser | undefined): Promise<void> {
  if (user) await sendPortalMails(request, [bigRequestMail(request, user, config.portal.url)]);
}
