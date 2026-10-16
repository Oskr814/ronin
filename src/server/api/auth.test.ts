import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { missingAuthConfig, parseCookies, sessionLogin, signSession, SESSION_COOKIE, type AuthConfig } from './auth.js';

const CONFIG: AuthConfig = {
  url: 'https://media.example.ts.net:8443',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  sessionSecret: 'x'.repeat(40),
  allowedUsers: ['oskr814'],
  sessionDays: 7,
};

const request = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as IncomingMessage;

describe('missingAuthConfig', () => {
  it('is empty when everything is set', () => {
    expect(missingAuthConfig(CONFIG)).toEqual([]);
  });

  it('names what is missing, and asks for a long session secret', () => {
    expect(missingAuthConfig({ ...CONFIG, githubClientId: '', sessionSecret: 'short', allowedUsers: [] })).toEqual([
      'DASHBOARD_GITHUB_CLIENT_ID', 'DASHBOARD_SESSION_SECRET (32+ caracteres)', 'DASHBOARD_ALLOWED_USERS',
    ]);
  });
});

describe('parseCookies', () => {
  it('reads every cookie of the header', () => {
    expect(parseCookies('a=1; ronin_session=x.y; b=%20z')).toEqual({ a: '1', ronin_session: 'x.y', b: ' z' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('sessions', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');

  it('lets in a signed, current session of someone on the allowlist', () => {
    const value = signSession('Oskr814', CONFIG.sessionSecret, 7, now);
    expect(sessionLogin(request(`${SESSION_COOKIE}=${value}`), CONFIG, now + 60_000)).toBe('oskr814');
  });

  it('turns away an expired session', () => {
    const value = signSession('oskr814', CONFIG.sessionSecret, 7, now);
    expect(sessionLogin(request(`${SESSION_COOKIE}=${value}`), CONFIG, now + 8 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it('turns away a session signed with another secret, or changed by hand', () => {
    const other = signSession('oskr814', 'y'.repeat(40), 7, now);
    expect(sessionLogin(request(`${SESSION_COOKIE}=${other}`), CONFIG, now)).toBeNull();
    const [, signature] = signSession('oskr814', CONFIG.sessionSecret, 7, now).split('.');
    const forged = Buffer.from(JSON.stringify({ login: 'oskr814', exp: now + 1e12 })).toString('base64url');
    expect(sessionLogin(request(`${SESSION_COOKIE}=${forged}.${signature}`), CONFIG, now)).toBeNull();
  });

  it('turns away someone taken off the allowlist, even with a valid session', () => {
    const value = signSession('oskr814', CONFIG.sessionSecret, 7, now);
    expect(sessionLogin(request(`${SESSION_COOKIE}=${value}`), { ...CONFIG, allowedUsers: ['otra'] }, now)).toBeNull();
  });

  it('is null without a cookie or with garbage', () => {
    expect(sessionLogin(request(), CONFIG, now)).toBeNull();
    expect(sessionLogin(request(`${SESSION_COOKIE}=nada`), CONFIG, now)).toBeNull();
  });
});
