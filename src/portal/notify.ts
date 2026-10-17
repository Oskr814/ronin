import { readFile } from 'node:fs/promises';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { sendMail, type Mail } from '../core/notifier.js';
import type { PortalUser } from './accounts.js';
import { bigRequestMail, PORTAL_FROM_NAME, teamRequestMail } from './mail.js';
import { prototypePatchPath, requestDir, type PortalRequest } from './requests.js';

// Sends a request's emails and logs the ones that fail: a lost email never
// holds a request back.
export async function sendPortalMails(request: PortalRequest, mails: Array<Mail | undefined>): Promise<void> {
  const results = await Promise.allSettled(mails.filter((m): m is Mail => Boolean(m)).map((m) => sendMail(m, PORTAL_FROM_NAME)));
  for (const result of results) {
    if (result.status === 'rejected') log.error(`portal: no se pudo enviar un correo del pedido P-${request.number}`, result.reason);
  }
}

// To the dev team, with the last prototype's diff when there is one.
export async function teamMail(request: PortalRequest, user: PortalUser | undefined): Promise<Mail> {
  const file = request.prototypes?.at(-1)?.patch;
  const patch = file ? await readFile(prototypePatchPath(request.number, file), 'utf8').catch(() => undefined) : undefined;
  return teamRequestMail(request, user, config.notifyTo, requestDir(request.number), patch);
}

// A request the team takes now: the person and the team hear about it.
export async function handOverMails(request: PortalRequest, user: PortalUser | undefined): Promise<void> {
  await sendPortalMails(request, [user ? bigRequestMail(request, user, config.portal.url) : undefined, await teamMail(request, user)]);
}
