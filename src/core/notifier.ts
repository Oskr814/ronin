import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log } from './logger.js';
import { recordBlock } from './local-state.js';

const BLOCK_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// The issue or PR a block is about, from its URL. A release (a failed
// changelog entry) has none: it gets no label, so the dashboard has nothing
// to show it on.
export function blockedItemNumber(url: string): number | null {
  const match = url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

export interface BlockerNotification {
  issueUrl: string;
  prUrl?: string;
  reason: string;
  excerpt?: string;
}

function transport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
  });
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Any other email ronin sends (the request portal's, #114), from the same
// account as the blockers. Unlike notifyBlocker it throws: the caller says
// whether the email went out.
export async function sendMail(mail: Mail, fromName = 'ronin'): Promise<void> {
  await transport().sendMail({ from: `"${fromName}" <${config.gmailUser}>`, ...mail });
}

// Fires only for the cases enumerated in docs/BLOCKING.md — waiting-for-review
// and transient quota backoff must never reach this function.
//
// Never throws: the reason is already logged below before the network call,
// so a caller's own escalation bookkeeping (attempt counters, the
// ronin:blocked label) still runs even if Gmail itself is unreachable.
// Discovered live: an earlier version let a transport failure here escape
// call sites that have no safety net of their own (discoverAssignedSpecs/
// discoverAssignedIssues in tick.ts, which run outside runIssueStep) —
// aborting the entire tick over a failed *notification about* an unrelated
// failure, instead of just failing to send one email.
export async function notifyBlocker(notification: BlockerNotification): Promise<void> {
  // Logged here, not at each call site, so every blocker — present and
  // future — lands in the tick log, not only in an email a human may not
  // check right away.
  log.error(
    `blocked: ${notification.reason}`,
    notification.prUrl ? { issueUrl: notification.issueUrl, prUrl: notification.prUrl } : { issueUrl: notification.issueUrl },
  );

  // Kept in the local state for the dashboard (#65), before
  // the email: a failed send must not lose it. Never throws either.
  const itemNumber = blockedItemNumber(notification.issueUrl);
  if (itemNumber !== null) {
    await recordBlock(itemNumber, {
      reason: notification.reason,
      url: notification.issueUrl,
      ...(notification.prUrl ? { prUrl: notification.prUrl } : {}),
      ...(notification.excerpt ? { excerpt: notification.excerpt } : {}),
      at: new Date().toISOString(),
    }, BLOCK_MAX_AGE_MS).catch((error) => log.error('notifyBlocker: no se pudo guardar el motivo en el estado local', error));
  }

  const lines = [
    `Motivo: ${notification.reason}`,
    `Issue: ${notification.issueUrl}`,
    notification.prUrl ? `PR: ${notification.prUrl}` : null,
    notification.excerpt ? `\n${notification.excerpt}` : null,
  ].filter((line): line is string => line !== null);

  try {
    await transport().sendMail({
      from: config.gmailUser,
      to: config.notifyTo,
      subject: `[ronin] Bloqueo: ${notification.reason}`,
      text: lines.join('\n'),
    });
  } catch (error) {
    log.error(`notifyBlocker: no se pudo enviar el email para "${notification.reason}"`, error);
  }
}
