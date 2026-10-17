import { readFile } from 'node:fs/promises';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { sendMail, type Mail } from '../core/notifier.js';
import type { PortalUser } from './accounts.js';
import { bigRequestMail, PORTAL_FROM_NAME, teamRequestMail } from './mail.js';
import { noteEvent, prototypePatchPath, requestDir, type PortalRequest } from './requests.js';

// Sends a request's emails and logs the ones that fail: a lost email never
// holds a request back. Each one, sent or not, goes to the request's
// activity (#132).
export async function sendPortalMails(request: PortalRequest, mails: Array<Mail | undefined>): Promise<void> {
  const sent = mails.filter((m): m is Mail => Boolean(m));
  const results = await Promise.allSettled(sent.map((m) => sendMail(m, PORTAL_FROM_NAME)));
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') log.error(`portal: no se pudo enviar un correo del pedido P-${request.number}`, result.reason);
    await noteEvent(request.number, { kind: 'mail', to: sent[i].to === config.notifyTo ? 'team' : 'person', subject: sent[i].subject, ok: result.status === 'fulfilled' });
  }
}

// Inside withActiveRepo: the team of the request's repo (its portal.notifyTo
// in repos.json), never another repo's; NOTIFY_TO when it has none.
export const teamTo = () => activeRepo().portal?.notifyTo?.join(', ') || config.notifyTo;

// To the dev team, with its issue and the last prototype's diff when there
// is one.
export async function teamMail(request: PortalRequest, user: PortalUser | undefined): Promise<Mail> {
  const file = request.prototypes?.at(-1)?.patch;
  const patch = file ? await readFile(prototypePatchPath(request.number, file), 'utf8').catch(() => undefined) : undefined;
  return teamRequestMail(request, user, teamTo(), requestDir(request.number), patch);
}

// A request the team takes now: the person hears right away; the team, with
// the link, once its issue is open (issue.ts).
export async function handOverMail(request: PortalRequest, user: PortalUser | undefined): Promise<void> {
  if (user) await sendPortalMails(request, [bigRequestMail(request, user, config.portal.url)]);
}
