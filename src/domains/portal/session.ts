import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseCookies } from '../../apps/api/http/auth.js';

// The portal's session (#114): a cookie with the account's id, its
// sessionVersion and the expiry, signed with HMAC under a key derived from
// PORTAL_SESSION_SECRET. Nothing secret travels in it, so it's signed, not
// encrypted (the dashboard's carries a GitHub token). The version is checked
// against the account on every request: a password change or disabling the
// account ends the session right away.

export const PORTAL_COOKIE = 'ronin_portal';
const VERSION = 'p1';

const key = (secret: string) => Buffer.from(hkdfSync('sha256', secret, '', 'ronin-portal-session', 32));
const sign = (payload: string, secret: string) => createHmac('sha256', key(secret)).update(payload).digest('base64url');

export interface PortalSession {
  userId: string;
  version: number;
}

export function sealPortalSession(session: PortalSession, secret: string, days: number, now = Date.now()): string {
  const payload = [VERSION, session.userId, session.version, now + days * 24 * 60 * 60 * 1000].join('.');
  return `${payload}.${sign(payload, secret)}`;
}

export function readPortalSession(req: IncomingMessage, secret: string, now = Date.now()): PortalSession | null {
  const value = parseCookies(req.headers.cookie)[PORTAL_COOKIE];
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const payload = parts.slice(0, 4).join('.');
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(parts[4]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const version = Number(parts[2]);
  const exp = Number(parts[3]);
  if (!parts[1] || !Number.isInteger(version) || !(exp > now)) return null;
  return { userId: parts[1], version };
}

export function portalCookie(value: string, maxAgeS: number): string {
  return `${PORTAL_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}
