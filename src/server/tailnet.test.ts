import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTailnetHandler } from './tailnet.js';
import { sealSession, type AuthConfig, type GithubOAuth } from './api/auth.js';

vi.mock('../core/repos.js', () => ({ loadRepos: async () => [{ productRepo: 'acme/product' }] }));
vi.mock('./api/dashboard-github.js', () => ({ repoGithub: async () => undefined }));
// Opening by number asks GitHub what it is: here, nothing.
vi.mock('../core/github.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../core/github.js')>()), itemKindOf: async () => null }));

const AUTH: AuthConfig = { url: 'https://media.example.ts.net:8443', githubClientId: 'cid', githubClientSecret: 'cs', sessionSecret: 's'.repeat(40), admins: ['oskr814'], allowedUsers: [], sessionDays: 7 };
// What GitHub would say (access.ts): oskr814 is an admin, valeria can triage acme/product, nobody else sees anything.
const access = vi.fn(async (s: { login: string }) => (s.login === 'oskr814' ? { admin: true, repos: [{ repo: 'acme/product', permission: 'admin-del-tablero' as const }] } : s.login === 'valeria' ? { admin: false, repos: [{ repo: 'acme/product', permission: 'triage' as const }] } : { admin: false, repos: [] }));
const github: GithubOAuth = {
  exchangeCode: vi.fn(async () => ({ token: 'gho_token', scopes: ['repo'] })),
  userLogin: vi.fn(async () => 'Oskr814'),
  revokeToken: vi.fn(async () => {}),
};

let server: Server;
let base: string;
const session = (token = 'gho_token', login = 'oskr814') => `ronin_session=${sealSession({ login, token }, AUTH.sessionSecret, 7)}`;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), 'ronin-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>ronin</title>');
  writeFileSync(join(web, 'app.js'), 'console.log(1)');
  mkdirSync(join(web, 'fonts'));
  writeFileSync(join(tmpdir(), 'ronin-secret.txt'), 'secret');
  const handle = createTailnetHandler(AUTH, { github, webRoot: web, access });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('tailnet listener', () => {
  it('serves the app without a session — it has no data of its own — with a strict CSP', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ronin</title>');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('text/javascript');
  });

  it('answers an app route with the app, and a missing file with 404', async () => {
    expect(await (await fetch(`${base}/i/acme%2Fproduct%23879`)).text()).toContain('<title>ronin</title>');
    expect((await fetch(`${base}/nada.js`)).status).toBe(404);
  });

  it('never serves a file outside the app', async () => {
    for (const path of ['/../ronin-secret.txt', '/%2e%2e/ronin-secret.txt', '/fonts/..%2f..%2fronin-secret.txt']) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text(), path).not.toBe('secret');
    }
  });

  it('asks for a session on the API', async () => {
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(401);
    const res = await fetch(`${base}/api/snapshot`, { headers: { cookie: session() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ me: 'oskr814', repos: ['acme/product'], items: [] });
  });

  it('serves evidence only behind the session, and only of a repo of ronin', async () => {
    const path = `${base}/api/evidence/other/repo/abc1234/a.png`;
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path, { headers: { cookie: session() } })).status).toBe(404);
  });

  it('logs in with GitHub asking for repo: state checked, the token kept only inside the sealed session', async () => {
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${AUTH.url}/api/auth/callback`);
    expect(location.searchParams.get('scope')).toBe('repo');
    const state = location.searchParams.get('state')!;
    const stateCookie = login.headers.get('set-cookie')!.split(';')[0];

    const callback = await fetch(`${base}/api/auth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');
    const cookies = callback.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => c.startsWith('ronin_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(sessionCookie).not.toContain('gho_token');

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: sessionCookie.split(';')[0] } });
    expect(await me.json()).toEqual({ login: 'oskr814' });
  });

  it('turns away a callback without the state it started with', async () => {
    const res = await fetch(`${base}/api/auth/callback?code=c1&state=otro`, { redirect: 'manual', headers: { cookie: 'ronin_oauth_state=uno' } });
    expect(res.status).toBe(400);
  });

  it('lets in someone who can triage a repo on GitHub, though not an admin (#106)', async () => {
    vi.mocked(github.userLogin).mockResolvedValueOnce('Valeria');
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const res = await fetch(`${base}/api/auth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } });
    expect(res.status).toBe(302);
    expect(access).toHaveBeenCalledWith({ login: 'valeria', token: 'gho_token' });
  });

  it('answers 401 to a session that can no longer see any repo', async () => {
    const res = await fetch(`${base}/api/snapshot`, { headers: { cookie: session('gho_x', 'exvaleria') } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain('ningún repo');
  });

  it('turns away someone who sees no repo on GitHub', async () => {
    vi.mocked(github.userLogin).mockResolvedValueOnce('intruso');
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const res = await fetch(`${base}/api/auth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ronin_session=') && !c.startsWith('ronin_session=;'))).toBe(false);
    expect(github.revokeToken).toHaveBeenCalledWith('gho_token', AUTH);
  });

  it('turns away a login that unchecked the repo scope, and revokes its token', async () => {
    vi.mocked(github.exchangeCode).mockResolvedValueOnce({ token: 'gho_sin_repo', scopes: [] });
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const res = await fetch(`${base}/api/auth/callback?code=c1&state=${state}`, { redirect: 'manual', headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('"repo"');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ronin_session=') && !c.startsWith('ronin_session=;'))).toBe(false);
    expect(github.revokeToken).toHaveBeenCalledWith('gho_sin_repo', AUTH);
  });

  it('revokes the token on logout, and clears the cookie even if GitHub fails', async () => {
    const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: AUTH.url, cookie: session('gho_salir') } });
    expect(ok.status).toBe(204);
    expect(github.revokeToken).toHaveBeenCalledWith('gho_salir', AUTH);
    vi.mocked(github.revokeToken).mockRejectedValueOnce(new Error('GitHub caído'));
    const failed = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: AUTH.url, cookie: session('gho_otro') } });
    expect(failed.status).toBe(204);
    expect(failed.headers.getSetCookie()[0]).toMatch(/^ronin_session=;.*Max-Age=0/);
  });

  it('refuses a change asked from another site', async () => {
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: session() } });
    expect(res.status).toBe(403);
    const ok = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: AUTH.url, cookie: session() } });
    expect(ok.status).toBe(204);
  });

  it("takes an action only from the page itself, as JSON, with a session", async () => {
    const url = `${base}/api/items/${encodeURIComponent('acme/product#12')}/actions`;
    const body = JSON.stringify({ action: 'resolve-conflicts' });
    expect((await fetch(url, { method: 'POST', body, headers: { origin: 'https://evil.example', cookie: session(), 'content-type': 'application/json' } })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', body, headers: { origin: AUTH.url, 'content-type': 'application/json' } })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', body: 'action=resolve-conflicts', headers: { origin: AUTH.url, cookie: session(), 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await fetch(url, { method: 'POST', body: '{', headers: { origin: AUTH.url, cookie: session(), 'content-type': 'application/json' } })).status).toBe(400);
    // Not an issue or PR GitHub knows of, nor one with runs.
    expect((await fetch(url, { method: 'POST', body, headers: { origin: AUTH.url, cookie: session(), 'content-type': 'application/json' } })).status).toBe(404);
  });
});
