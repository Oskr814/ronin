import type { IncomingMessage } from 'node:http';
import type { RepoEntry } from '../../core/repo-context.js';
import { getUser, type PortalUser } from './accounts.js';
import type { Send } from './send-link.js';
import { readPortalSession } from './session.js';

// What the portal's routes (routes.ts, routes-requests.ts) share: how it's
// set up, and who's asking.

export interface PortalConfig {
  url: string;
  sessionSecret: string;
  sessionDays: number;
  // Requests per person per day, unless their account sets its own.
  dailyLimit: number;
}

export interface PortalDeps {
  entries: () => Promise<RepoEntry[]>;
  send?: Send;
  // Starts the worker that reads a request (domains/portal/launch.ts).
  launch?: (n: number) => Promise<void>;
}

// Behind Cloudflare's tunnel and nginx-proxy-manager the socket is the
// proxy's: the client is in Cloudflare's header.
export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'desconocida';
}

// The account behind a request's cookie: it exists, isn't disabled, and its
// password hasn't changed since the cookie was made.
export async function portalUser(req: IncomingMessage, config: PortalConfig): Promise<PortalUser | null> {
  const session = readPortalSession(req, config.sessionSecret);
  if (!session) return null;
  const user = await getUser(session.userId);
  return user && !user.disabled && user.passwordHash && user.sessionVersion === session.version ? user : null;
}
