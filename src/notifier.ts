import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log } from './logger.js';

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

// Fires only for the cases enumerated in docs/BLOCKING.md — waiting-for-review
// and transient quota backoff must never reach this function.
//
// Never throws: the reason is already logged below before the network call,
// so a caller's own escalation bookkeeping (attempt counters, the
// valeria:blocked label) still runs even if Gmail itself is unreachable.
// Discovered live: an earlier version let a transport failure here escape
// call sites that have no safety net of their own (discoverAssignedSpecs/
// discoverAssignedBugs in tick.ts, which run outside runIssueStep) —
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
      subject: `[ValerIA] Bloqueo: ${notification.reason}`,
      text: lines.join('\n'),
    });
  } catch (error) {
    log.error(`notifyBlocker: no se pudo enviar el email para "${notification.reason}"`, error);
  }
}
