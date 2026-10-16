import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../core/logger.js';

// Login with GitHub for the dashboard (#65). An OAuth App with no scopes:
// all ronin needs is who you are. The GitHub token is used once, to read
// /user, and dropped. The session is a signed cookie — login and expiry,
// HMAC'd with the session secret — so there's no session state on the
// server. The allowlist is checked on every request, not only at login:
// taking someone off it locks them out right away.

export interface AuthConfig {
  url: string;
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  allowedUsers: string[];
  sessionDays: number;
}

export const SESSION_COOKIE = 'ronin_session';
const STATE_COOKIE = 'ronin_oauth_state';
const STATE_MAX_AGE_S = 600;

// What's missing for the dashboard to run; empty means it can.
export function missingAuthConfig(config: AuthConfig): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push('DASHBOARD_URL');
  if (!config.githubClientId) missing.push('DASHBOARD_GITHUB_CLIENT_ID');
  if (!config.githubClientSecret) missing.push('DASHBOARD_GITHUB_CLIENT_SECRET');
  if (config.sessionSecret.length < 32) missing.push('DASHBOARD_SESSION_SECRET (32+ caracteres)');
  if (config.allowedUsers.length === 0) missing.push('DASHBOARD_ALLOWED_USERS');
  return missing;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(login: string, secret: string, days: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ login: login.toLowerCase(), exp: now + days * 24 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

// The login a request's session belongs to, or null: no cookie, a bad
// signature, expired, or no longer on the allowlist.
export function sessionLogin(req: IncomingMessage, config: AuthConfig, now = Date.now()): string | null {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!value) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(hmac(config.sessionSecret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { login, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { login?: unknown; exp?: unknown };
    if (typeof login !== 'string' || typeof exp !== 'number' || exp <= now) return null;
    return config.allowedUsers.includes(login) ? login : null;
  } catch {
    return null;
  }
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
  exchangeCode(code: string, config: AuthConfig): Promise<string>;
  userLogin(token: string): Promise<string>;
}

export const githubOAuth: GithubOAuth = {
  async exchangeCode(code, config) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: callbackUrl(config) }),
    });
    const body = (await response.json()) as { access_token?: string; error?: string };
    if (!body.access_token) throw new Error(`GitHub no devolvió un token: ${body.error ?? response.status}`);
    return body.access_token;
  },
  async userLogin(token) {
    const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ronin-dashboard' } });
    if (!response.ok) throw new Error(`GitHub /user respondió ${response.status}`);
    const body = (await response.json()) as { login?: string };
    if (!body.login) throw new Error('GitHub /user no trajo el login');
    return body.login;
  },
};

// /api/auth/*. Returns false for a path it doesn't own.
export async function handleAuth(req: IncomingMessage, res: ServerResponse, path: string, config: AuthConfig, github: GithubOAuth = githubOAuth): Promise<boolean> {
  if (path === '/api/auth/login' && req.method === 'GET') {
    const state = randomBytes(16).toString('base64url');
    const params = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: callbackUrl(config), state, allow_signup: 'false' });
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
    try {
      login = (await github.userLogin(await github.exchangeCode(code, config))).toLowerCase();
    } catch (error) {
      log.error('tablero: falló el login con GitHub', error);
      text(res, 502, 'No se pudo completar el login con GitHub. Probá de nuevo.');
      return true;
    }
    if (!config.allowedUsers.includes(login)) {
      log.info(`tablero: login rechazado para ${login}, no está en DASHBOARD_ALLOWED_USERS`);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': [clearState] }).end(`${login} no tiene acceso a este tablero.`);
      return true;
    }
    log.info(`tablero: ${login} entró`);
    redirect(res, '/', [clearState, cookie(SESSION_COOKIE, signSession(login, config.sessionSecret, config.sessionDays), config.sessionDays * 24 * 60 * 60)]);
    return true;
  }

  if (path === '/api/auth/logout' && req.method === 'POST') {
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
