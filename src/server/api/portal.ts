import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../core/logger.js';
import type { RepoEntry } from '../../core/repo-context.js';
import { findUserByEmail, getUser, normalizeEmail, recordLogin, redeemLink, userForLink, type PortalUser } from '../../portal/accounts.js';
import { grantedApps } from '../../portal/apps.js';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from '../../portal/password.js';
import { RateLimit } from '../../portal/rate-limit.js';
import { sendPasswordLink, type Send } from '../../portal/send-link.js';
import { startedToday } from '../../portal/requests.js';
import { portalCookie, readPortalSession, sealPortalSession } from '../../portal/session.js';
import { handlePortalRequests } from './portal-requests.js';

// The request portal's API (#114), on the public listener:
//   POST /api/portal/login     { email, password }: the session cookie
//   POST /api/portal/logout
//   GET  /api/portal/me        who's in, and the apps they can ask in
//   POST /api/portal/forgot    { email }: a link to change the password, if the account exists
//   POST /api/portal/link      { token }: whose password a link sets, while it's good
//   POST /api/portal/password  { token, password }: sets it with the link, and logs in
//   /api/portal/requests…      the person's requests and their conversation (portal-requests.ts)
//
// It answers the same to an unknown email and a wrong password, and takes as
// long, so the login doesn't tell which emails have an account; the same for
// a reset asked for an email without one.

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
  // Starts the worker that reads a request (portal/launch.ts).
  launch?: (n: number) => Promise<void>;
}

const WINDOW_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
// Failed logins: per email, what stops guessing one account's password; per
// IP, what stops trying many.
const loginByEmail = new RateLimit(5, WINDOW_MS);
const loginByIp = new RateLimit(30, WINDOW_MS);
const forgotByEmail = new RateLimit(3, HOUR_MS);
const forgotByIp = new RateLimit(10, HOUR_MS);
const linkByIp = new RateLimit(20, WINDOW_MS);

const TOO_MANY = 'Demasiados intentos. Prueba de nuevo en unos minutos.';
const BAD_LOGIN = 'Correo o contraseña incorrectos.';
const BAD_LINK = 'El enlace venció o ya se usó. Pide uno nuevo desde "¿Olvidaste tu contraseña?".';

// For the tests, which log in many times.
export function resetPortalLimits(): void {
  for (const limit of [loginByEmail, loginByIp, forgotByEmail, forgotByIp, linkByIp]) limit.reset();
}

export function json(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }).end(JSON.stringify(body));
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

const MAX_BODY = 8 * 1024;

export async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

// The account behind a request's cookie: it exists, isn't disabled, and its
// password hasn't changed since the cookie was made.
export async function portalUser(req: IncomingMessage, config: PortalConfig): Promise<PortalUser | null> {
  const session = readPortalSession(req, config.sessionSecret);
  if (!session) return null;
  const user = await getUser(session.userId);
  return user && !user.disabled && user.passwordHash && user.sessionVersion === session.version ? user : null;
}

function sessionCookie(user: PortalUser, config: PortalConfig): string {
  return portalCookie(sealPortalSession({ userId: user.id, version: user.sessionVersion }, config.sessionSecret, config.sessionDays), config.sessionDays * 24 * 60 * 60);
}

async function me(user: PortalUser, config: PortalConfig, deps: PortalDeps) {
  const limit = user.dailyLimit ?? config.dailyLimit;
  return { name: user.name, email: user.email, apps: grantedApps(user.grants, await deps.entries()), today: { used: await startedToday(user.id), limit } };
}

// /api/portal/*. Returns false for a path it doesn't own.
export async function handlePortalApi(req: IncomingMessage, res: ServerResponse, path: string, config: PortalConfig, deps: PortalDeps): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (path === '/api/portal/me' && method === 'GET') {
    const user = await portalUser(req, config);
    if (user) json(res, 200, await me(user, config, deps));
    else json(res, 401, { error: 'sin sesión' }, [portalCookie('', 0)]);
    return true;
  }

  if (path === '/api/portal/requests' || path.startsWith('/api/portal/requests/')) {
    await handlePortalRequests(req, res, path, config, deps);
    return true;
  }

  if (path === '/api/portal/logout' && method === 'POST') {
    res.writeHead(204, { 'Set-Cookie': [portalCookie('', 0)] }).end();
    return true;
  }

  const posts = ['/api/portal/login', '/api/portal/forgot', '/api/portal/link', '/api/portal/password'];
  if (!posts.includes(path)) return false;
  if (method !== 'POST') {
    json(res, 405, { error: 'método no permitido' });
    return true;
  }
  const body = await readJson(req);
  if (!body) {
    json(res, 400, { error: 'pedido inválido' });
    return true;
  }
  const ip = clientIp(req);

  if (path === '/api/portal/login') {
    const email = normalizeEmail(str(body.email));
    const password = str(body.password);
    if (loginByEmail.blocked(email) || loginByIp.blocked(ip)) {
      json(res, 429, { error: TOO_MANY });
      return true;
    }
    const user = email ? await findUserByEmail(email) : undefined;
    const ok = user?.passwordHash && !user.disabled ? await verifyPassword(password, user.passwordHash) : (await burnPasswordCheck(password), false);
    if (!ok || !user) {
      loginByEmail.hit(email);
      loginByIp.hit(ip);
      log.info(`portal: login fallido para ${email || '(sin correo)'} desde ${ip}`);
      json(res, 401, { error: BAD_LOGIN });
      return true;
    }
    loginByEmail.clear(email);
    await recordLogin(user.id);
    log.info(`portal: ${user.email} entró`);
    json(res, 200, await me(user, config, deps), [sessionCookie(user, config)]);
    return true;
  }

  if (path === '/api/portal/forgot') {
    const email = normalizeEmail(str(body.email));
    if (forgotByIp.blocked(ip) || forgotByEmail.blocked(email)) {
      json(res, 429, { error: TOO_MANY });
      return true;
    }
    forgotByIp.hit(ip);
    forgotByEmail.hit(email);
    const user = email ? await findUserByEmail(email) : undefined;
    // An account still waiting on its invitation gets a new invitation.
    if (user && !user.disabled) await sendPasswordLink(user, user.passwordHash ? 'reset' : 'invite', { portalUrl: config.url, entries: await deps.entries(), send: deps.send });
    res.writeHead(204).end();
    return true;
  }

  const token = str(body.token);
  if (linkByIp.blocked(ip)) {
    json(res, 429, { error: TOO_MANY });
    return true;
  }

  if (path === '/api/portal/link') {
    const user = token ? await userForLink(token) : undefined;
    if (!user?.link) {
      linkByIp.hit(ip);
      json(res, 404, { error: BAD_LINK });
      return true;
    }
    json(res, 200, { name: user.name, email: user.email, kind: user.link.kind });
    return true;
  }

  // /api/portal/password
  const problem = passwordProblem(body.password);
  if (problem) {
    json(res, 400, { error: problem });
    return true;
  }
  const user = token ? await redeemLink(token, await hashPassword(str(body.password))) : undefined;
  if (!user) {
    linkByIp.hit(ip);
    json(res, 404, { error: BAD_LINK });
    return true;
  }
  loginByEmail.clear(user.email);
  await recordLogin(user.id);
  log.info(`portal: ${user.email} puso su contraseña`);
  json(res, 200, await me(user, config, deps), [sessionCookie(user, config)]);
  return true;
}
