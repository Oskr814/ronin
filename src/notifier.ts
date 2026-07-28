import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface BlockerNotification {
  issueUrl: string;
  prUrl?: string;
  reason: string;
  excerpt?: string;
}

function transport() {
  if (!config.gmailUser || !config.gmailAppPassword) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set — cannot send blocker notifications');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
  });
}

// Fires only for the cases enumerated in docs/BLOCKING.md — waiting-for-review
// and transient quota backoff must never reach this function.
export async function notifyBlocker(notification: BlockerNotification): Promise<void> {
  if (!config.notifyTo) {
    throw new Error('NOTIFY_TO not set — cannot send blocker notifications');
  }

  const lines = [
    `Motivo: ${notification.reason}`,
    `Issue: ${notification.issueUrl}`,
    notification.prUrl ? `PR: ${notification.prUrl}` : null,
    notification.excerpt ? `\n${notification.excerpt}` : null,
  ].filter((line): line is string => line !== null);

  await transport().sendMail({
    from: config.gmailUser,
    to: config.notifyTo,
    subject: `[ValerIA] Bloqueo: ${notification.reason}`,
    text: lines.join('\n'),
  });
}
