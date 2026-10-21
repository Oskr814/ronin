import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';
import { missingAuthConfig, readSession, sealSession, sessionLogin, SESSION_COOKIE, type AuthConfig } from './auth.js';
import { parseCookies } from '../../../platform/http/cookies.js';

const CONFIG: AuthConfig = {
  url: 'https://media.example.ts.net:8443',
  githubClientId: 'id',
  githubClientSecret: 'secret',
  sessionSecret: 'x'.repeat(40),
  admins: ['oskr814'],
  allowedUsers: ['oskr814'],
  sessionDays: 7,
};

const request = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as IncomingMessage;

describe('missingAuthConfig', () => {
  it('is empty when everything is set', () => {
    expect(missingAuthConfig(CONFIG)).toEqual([]);
  });

  it('names what is missing, and asks for a long session secret', () => {
    expect(missingAuthConfig({ ...CONFIG, githubClientId: '', sessionSecret: 'short' })).toEqual([
      'DASHBOARD_GITHUB_CLIENT_ID', 'DASHBOARD_SESSION_SECRET (32+ caracteres)',
    ]);
    // Without admins it runs too: everyone sees what GitHub lets them.
    expect(missingAuthConfig({ ...CONFIG, admins: [] })).toEqual([]);
    // Without a list of who gets in, GitHub decides (#106).
    expect(missingAuthConfig({ ...CONFIG, allowedUsers: [] })).toEqual([]);
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
  const seal = (login = 'oskr814', secret = CONFIG.sessionSecret) => sealSession({ login, token: 'gho_secreto' }, secret, 7, now);

  it('lets in a current session of someone on the allowlist, with the GitHub token', () => {
    const value = seal('Oskr814');
    expect(readSession(request(`${SESSION_COOKIE}=${value}`), CONFIG, now + 60_000)).toEqual({ login: 'oskr814', token: 'gho_secreto' });
    expect(sessionLogin(request(`${SESSION_COOKIE}=${value}`), CONFIG, now + 60_000)).toBe('oskr814');
  });

  it('never carries the token in the clear', () => {
    const value = seal();
    expect(value).not.toContain('gho_secreto');
    expect(Buffer.from(value.split('.')[2], 'base64url').toString('latin1')).not.toContain('gho_secreto');
  });

  it('turns away an expired session', () => {
    expect(readSession(request(`${SESSION_COOKIE}=${seal()}`), CONFIG, now + 8 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it('turns away a session sealed with another secret, or changed by hand', () => {
    expect(readSession(request(`${SESSION_COOKIE}=${seal('oskr814', 'y'.repeat(40))}`), CONFIG, now)).toBeNull();
    const [version, iv, sealed, tag] = seal().split('.');
    const flipped = Buffer.from(sealed, 'base64url');
    flipped[0] ^= 1;
    expect(readSession(request(`${SESSION_COOKIE}=${[version, iv, flipped.toString('base64url'), tag].join('.')}`), CONFIG, now)).toBeNull();
  });

  it('turns away a cookie of the older format, signed but without a token', () => {
    const payload = Buffer.from(JSON.stringify({ login: 'oskr814', exp: now + 1e9 })).toString('base64url');
    const signature = createHmac('sha256', CONFIG.sessionSecret).update(payload).digest('base64url');
    expect(readSession(request(`${SESSION_COOKIE}=${payload}.${signature}`), CONFIG, now)).toBeNull();
  });

  it('turns away someone taken off the allowlist, even with a valid session', () => {
    expect(readSession(request(`${SESSION_COOKIE}=${seal()}`), { ...CONFIG, admins: [], allowedUsers: ['otra'] }, now)).toBeNull();
  });

  it('lets in an admin whatever the allowlist says, and anyone when it is empty (#106)', () => {
    expect(readSession(request(`${SESSION_COOKIE}=${seal()}`), { ...CONFIG, allowedUsers: ['otra'] }, now)?.login).toBe('oskr814');
    expect(readSession(request(`${SESSION_COOKIE}=${seal()}`), { ...CONFIG, admins: ['otra'], allowedUsers: [] }, now)?.login).toBe('oskr814');
  });

  it('is null without a cookie or with garbage', () => {
    expect(sessionLogin(request(), CONFIG, now)).toBeNull();
    expect(sessionLogin(request(`${SESSION_COOKIE}=nada`), CONFIG, now)).toBeNull();
  });
});
