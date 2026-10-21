import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../../platform/logger.js';
import { timed } from '../../../platform/timing.js';
import { parseCookies } from '../../../platform/http/cookies.js';
import type { Session } from '../../../domains/access/http.js';
import { githubFetch } from '../../../platform/github/rest.js';

// Login with GitHub for the dashboard (#65). The OAuth App asks for the
// `repo` scope (#93): what the dashboard does on GitHub — a comment, a
// review — goes out as whoever logged in, not as ronin. The dashboard is
// only reachable on the tailnet, which is why a token that can write is
// acceptable. Who gets in (#106): the DASHBOARD_ADMINS, and anyone who can
// triage a repo of repos.json on GitHub (access/access.ts decides, through
// `canEnter`); DASHBOARD_ALLOWED_USERS, when set, narrows that to a list.
//
// The session is a cookie with the login, the expiry and the GitHub token,
// encrypted with AES-256-GCM under a key derived from the session secret:
// GCM both hides the token and rejects a cookie changed by hand, and
// there's still no session state on the server. Logging out revokes the
// token on GitHub. The lists are checked on every request, not only at
// login: taking someone off them locks them out right away.

export interface AuthConfig {
  url: string;
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  admins: string[];
  allowedUsers: string[];
  sessionDays: number;
}

export const SESSION_COOKIE = 'ronin_session';
const STATE_COOKIE = 'ronin_oauth_state';
const STATE_MAX_AGE_S = 600;
export const OAUTH_SCOPE = 'repo';
// Cookies of an older format (the HMAC-signed one, without a token) don't
// start with this, so they read as no session and the page asks to log in.
const SESSION_VERSION = 'v2';

// What's missing for the dashboard to run; empty means it can.
export function missingAuthConfig(config: AuthConfig): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push('DASHBOARD_URL');
  if (!config.githubClientId) missing.push('DASHBOARD_GITHUB_CLIENT_ID');
  if (!config.githubClientSecret) missing.push('DASHBOARD_GITHUB_CLIENT_SECRET');
  if (config.sessionSecret.length < 32) missing.push('DASHBOARD_SESSION_SECRET (32+ caracteres)');
  return missing;
}


function sessionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', 'ronin-dashboard-session', 32));
}

export function sealSession(session: Session, secret: string, days: number, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(secret), iv);
  const plain = JSON.stringify({ login: session.login.toLowerCase(), token: session.token, exp: now + days * 24 * 60 * 60 * 1000 });
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [SESSION_VERSION, iv, sealed, cipher.getAuthTag()].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

function openSession(value: string, secret: string): { login?: unknown; token?: unknown; exp?: unknown } | null {
  const [version, iv, sealed, tag, ...rest] = value.split('.');
  if (version !== SESSION_VERSION || !iv || !sealed || !tag || rest.length > 0) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

// A request's session, or null: no cookie, an older format, one that
// doesn't decrypt (another secret, changed by hand), expired, or of someone
// DASHBOARD_ALLOWED_USERS no longer lets in.
export function readSession(req: IncomingMessage, config: AuthConfig, now = Date.now()): Session | null {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const opened = value ? openSession(value, config.sessionSecret) : null;
  if (!opened) return null;
  const { login, token, exp } = opened;
  if (typeof login !== 'string' || typeof token !== 'string' || !token || typeof exp !== 'number' || exp <= now) return null;
  return mayEnter(config, login) ? { login, token } : null;
}

// What the lists say about a login; GitHub has the last word on everyone
// but the admins (`canEnter`, at login, and access/access.ts on every request).
function mayEnter(config: AuthConfig, login: string): boolean {
  return config.admins.includes(login) || config.allowedUsers.length === 0 || config.allowedUsers.includes(login);
}

export function sessionLogin(req: IncomingMessage, config: AuthConfig, now = Date.now()): string | null {
  return readSession(req, config, now)?.login ?? null;
}

function cookie(name: string, value: string, maxAgeS: number, path = '/'): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, { Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }).end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
}

const callbackUrl = (config: AuthConfig) => `${config.url}/api/auth/callback`;

// GitHub's side of the flow, apart so tests can stand in for it.
export interface GithubOAuth {
  // The token and the scopes the person actually granted.
  exchangeCode(code: string, config: AuthConfig): Promise<{ token: string; scopes: string[] }>;
  userLogin(token: string): Promise<string>;
  revokeToken(token: string, config: AuthConfig): Promise<void>;
}

export const githubOAuth: GithubOAuth = {
  async exchangeCode(code, config) {
    const response = await timed('github', () => fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: callbackUrl(config) }),
    }));
    const body = (await response.json()) as { access_token?: string; scope?: string; error?: string };
    if (!body.access_token) throw new Error(`GitHub no devolvió un token: ${body.error ?? response.status}`);
    return { token: body.access_token, scopes: (body.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
  },
  async userLogin(token) {
    const response = await githubFetch('/user', { token });
    if (!response.ok) throw new Error(`GitHub /user respondió ${response.status}`);
    const body = (await response.json()) as { login?: string };
    if (!body.login) throw new Error('GitHub /user no trajo el login');
    return body.login;
  },
  async revokeToken(token, config) {
    const basic = Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString('base64');
    const response = await githubFetch(`/applications/${config.githubClientId}/token`, { method: 'DELETE', authorization: `Basic ${basic}`, body: { access_token: token } });
    // 404: GitHub no longer knows it (revoked from the account settings).
    if (!response.ok && response.status !== 404) throw new Error(`GitHub respondió ${response.status} al revocar el token`);
  },
};

// /api/auth/*. Returns false for a path it doesn't own.
// Whether a login with this token gets in, past the lists: an admin always,
// anyone else only with some repo to see (access/access.ts). The default is the
// lists alone.
export type CanEnter = (login: string, token: string) => Promise<boolean>;

export async function handleAuth(req: IncomingMessage, res: ServerResponse, path: string, config: AuthConfig, github: GithubOAuth = githubOAuth, canEnter: CanEnter = async (login) => config.admins.includes(login)): Promise<boolean> {
  if (path === '/api/auth/login' && req.method === 'GET') {
    const state = randomBytes(16).toString('base64url');
    const params = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: callbackUrl(config), scope: OAUTH_SCOPE, state, allow_signup: 'false' });
    redirect(res, `https://github.com/login/oauth/authorize?${params}`, [cookie(STATE_COOKIE, state, STATE_MAX_AGE_S, '/api/auth')]);
    return true;
  }

  if (path === '/api/auth/callback' && req.method === 'GET') {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    const clearState = cookie(STATE_COOKIE, '', 0, '/api/auth');
    const state = query.get('state') ?? '';
    if (!expected || expected.length !== state.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(state))) {
      text(res, 400, 'El login venció o no empezó acá. Volvé a entrar desde el tablero.');
      return true;
    }
    const code = query.get('code');
    if (!code) {
      text(res, 400, 'GitHub no devolvió el código de autorización.');
      return true;
    }
    let login: string;
    let granted: { token: string; scopes: string[] };
    try {
      granted = await github.exchangeCode(code, config);
      login = (await github.userLogin(granted.token)).toLowerCase();
    } catch (error) {
      log.error('tablero: falló el login con GitHub', error);
      text(res, 502, 'No se pudo completar el login con GitHub. Probá de nuevo.');
      return true;
    }
    const drop = () => github.revokeToken(granted.token, config).catch((error) => log.error(`tablero: no se pudo revocar el token de ${login}`, error));
    let enters = false;
    try {
      enters = mayEnter(config, login) && (await canEnter(login, granted.token));
    } catch (error) {
      log.error(`tablero: no se pudo ver a qué repos tiene acceso ${login}`, error);
    }
    if (!enters) {
      log.info(`tablero: login rechazado para ${login}: no es admin ni puede ver ningún repo`);
      await drop();
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': [clearState] }).end(`${login} no tiene acceso a este tablero: hace falta poder gestionar issues (triage) en alguno de sus repos de GitHub.`);
      return true;
    }
    // The person can uncheck the scope on GitHub's page; without it the
    // dashboard couldn't act as them.
    if (!granted.scopes.includes(OAUTH_SCOPE)) {
      log.info(`tablero: ${login} no dio el permiso ${OAUTH_SCOPE}`);
      await drop();
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': [clearState] }).end(`El tablero necesita el permiso "${OAUTH_SCOPE}" de GitHub para comentar y aprobar a tu nombre. Volvé a entrar y aceptalo.`);
      return true;
    }
    log.info(`tablero: ${login} entró`);
    redirect(res, '/', [clearState, cookie(SESSION_COOKIE, sealSession({ login, token: granted.token }, config.sessionSecret, config.sessionDays), config.sessionDays * 24 * 60 * 60)]);
    return true;
  }

  if (path === '/api/auth/logout' && req.method === 'POST') {
    // The cookie goes either way; a token GitHub couldn't revoke still dies
    // with the cookie on this browser, and is logged.
    const session = readSession(req, config);
    if (session) await github.revokeToken(session.token, config).catch((error) => log.error(`tablero: no se pudo revocar el token de ${session.login} al salir`, error));
    res.writeHead(204, { 'Set-Cookie': [cookie(SESSION_COOKIE, '', 0)] }).end();
    return true;
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    const login = sessionLogin(req, config);
    if (login) json(res, 200, { login });
    else json(res, 401, { error: 'sin sesión' });
    return true;
  }

  return false;
}
