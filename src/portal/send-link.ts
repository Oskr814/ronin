import { log } from '../core/logger.js';
import { sendMail, type Mail } from '../core/notifier.js';
import type { RepoEntry } from '../core/repo-context.js';
import { issueLink, type LinkKind, type PortalUser } from './accounts.js';
import { grantedApps } from './apps.js';
import { linkMail, linkUrl, PORTAL_FROM_NAME } from './mail.js';

export type Send = (mail: Mail, fromName: string) => Promise<void>;

// A new link to set the password, by email (#114). Says whether the email
// went out, and the link itself: the dashboard shows it to the admin when
// the email failed, so they can pass it on another way.
export async function sendPasswordLink(user: PortalUser, kind: LinkKind, opts: { portalUrl: string; entries: RepoEntry[]; send?: Send }): Promise<{ sent: boolean; url: string }> {
  const { user: fresh, token } = await issueLink(user.id, kind);
  const url = linkUrl(opts.portalUrl, token);
  try {
    await (opts.send ?? sendMail)(linkMail(fresh, kind, url, opts.portalUrl, grantedApps(fresh.grants, opts.entries)), PORTAL_FROM_NAME);
    log.info(`portal: enlace de ${kind === 'invite' ? 'invitación' : 'contraseña'} enviado a ${fresh.email}`);
    return { sent: true, url };
  } catch (error) {
    log.error(`portal: no se pudo enviar el enlace a ${fresh.email}`, error);
    return { sent: false, url };
  }
}
