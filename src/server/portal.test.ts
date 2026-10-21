import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../core/config.js';
import { createUser, issueLink, redeemLink, updateUser } from '../portal/accounts.js';
import { hashPassword } from '../portal/password.js';
import { hc } from 'hono/client';
import { resetPortalLimits, type PortalApi } from '../portal/routes.js';
import { createPortalHandler, portalVersion } from './portal.js';

vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const PORTAL = { url: 'https://ronin-agent.example.com', sessionSecret: 'p'.repeat(40), sessionDays: 30, dailyLimit: 2 };
const entries = [
  { productRepo: 'redmotos/shoppingcart', productRepoPath: '/x', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice', description: 'Pedidos' }, tienda: { name: 'Tienda' } } } },
  { productRepo: 'Bmedical/bmedical', productRepoPath: '/y' },
];
const send = vi.fn(async () => {});

let server: Server;
let base: string;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), 'ronin-portal-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Pedidos</title><script src="/portal.js" type="module"></script>');
  writeFileSync(join(web, 'portal.js'), 'console.log(1)');
  const fonts = mkdtempSync(join(tmpdir(), 'ronin-fonts-'));
  writeFileSync(join(fonts, 'a.woff2'), 'font');
  writeFileSync(join(fonts, '..', 'app.js'), 'dashboard');
  const handle = createPortalHandler(PORTAL, { webRoot: web, fontsRoot: fonts, deps: { entries: async () => entries, send } });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  resetPortalLimits();
  send.mockClear();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PORTAL.url, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

async function maria(password = 'clave-de-maria') {
  const user = await createUser({ email: 'mfernandez@redmotoshn.com', name: 'María Fernández', grants: [{ repo: 'redmotos/shoppingcart', app: 'backoffice' }, { repo: 'gone/repo', app: 'web' }], createdBy: 'oskr814' });
  const { token } = await issueLink(user.id, 'invite');
  return (await redeemLink(token, await hashPassword(password)))!;
}

describe('request portal', () => {
  it('serves its app with a strict CSP, and only the fonts of the dashboard', async () => {
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain('<title>Pedidos</title>');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await (await fetch(`${base}/contrasena`)).text()).toContain('<title>Pedidos</title>');
    expect(await (await fetch(`${base}/fonts/a.woff2`)).text()).toBe('font');
    expect(await (await fetch(`${base}/fonts/..%2fapp.js`)).text()).not.toBe('dashboard');
    expect((await fetch(`${base}/fonts/x`)).status).toBe(404);
  });

  it('names its script with a version, so a deploy is never hidden behind a cache, and serves it by that URL', async () => {
    const html = await (await fetch(`${base}/p/3`)).text();
    const src = /src="(\/portal\.js\?v=\w+)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    expect(await (await fetch(`${base}${src}`)).text()).toBe('console.log(1)');
  });

  it('answers its API with the version of the page, which changes with its files, so a page opened before a deploy reloads', async () => {
    const version = (await fetch(`${base}/api/portal/me`)).headers.get('x-portal-version');
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect((await fetch(`${base}/api/nada`)).headers.get('x-portal-version')).toBe(version);
    const web = mkdtempSync(join(tmpdir(), 'ronin-portal-v-'));
    writeFileSync(join(web, 'portal.js'), 'console.log(1)');
    const before = portalVersion(web);
    writeFileSync(join(web, 'portal.js'), 'console.log(2)');
    expect(portalVersion(web)).not.toBe(before);
  });

  it('knows nothing of the dashboard API', async () => {
    for (const path of ['/api/snapshot', '/api/auth/login', '/api/portal-admin']) expect((await fetch(`${base}${path}`)).status, path).toBe(404);
  });

  it('refuses a POST from another origin, or not as JSON', async () => {
    expect((await post('/api/portal/login', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    const form = await fetch(`${base}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PORTAL.url }, body: 'email=a' });
    expect(form.status).toBe(403);
  });

  it('logs in with email and password and answers who it is and the apps it can ask in', async () => {
    await maria();
    const res = await post('/api/portal/login', { email: 'MFernandez@redmotoshn.com', password: 'clave-de-maria' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ronin_portal=.+HttpOnly; Secure; SameSite=Lax/);
    const me = await (await fetch(`${base}/api/portal/me`, { headers: { Cookie: cookieOf(res) } })).json();
    // The grant for a repo that's no longer in the portal offers nothing.
    expect(me).toEqual({ name: 'María Fernández', email: 'mfernandez@redmotoshn.com', apps: [{ repo: 'redmotos/shoppingcart', org: 'Red Motos', app: 'backoffice', name: 'Backoffice', description: 'Pedidos' }], today: { used: 0, limit: 2 } });
  });

  it('answers the same to a wrong password, an unknown email and an account without a password', async () => {
    await maria();
    await createUser({ email: 'nueva@x.com', name: 'Nueva', grants: [], createdBy: 'oskr814' });
    for (const [email, password] of [['mfernandez@redmotoshn.com', 'otra-clave-x'], ['nadie@x.com', 'clave-de-maria'], ['nueva@x.com', 'clave-de-maria']]) {
      const res = await post('/api/portal/login', { email, password });
      expect(res.status, email).toBe(401);
      expect((await res.json()).error).toBe('Correo o contraseña incorrectos.');
    }
  });

  it('stops guessing after 5 failures per email, even with the right password', async () => {
    await maria();
    for (let i = 0; i < 5; i++) expect((await post('/api/portal/login', { email: 'mfernandez@redmotoshn.com', password: `mala-clave-${i}` })).status).toBe(401);
    expect((await post('/api/portal/login', { email: 'mfernandez@redmotoshn.com', password: 'clave-de-maria' })).status).toBe(429);
  });

  it('a session ends with a password change or when the account is disabled', async () => {
    const user = await maria();
    const cookie = cookieOf(await post('/api/portal/login', { email: user.email, password: 'clave-de-maria' }));
    const me = () => fetch(`${base}/api/portal/me`, { headers: { Cookie: cookie } });
    expect((await me()).status).toBe(200);

    const { token } = await issueLink(user.id, 'reset');
    await post('/api/portal/password', { token, password: 'clave-nueva-de-maria' });
    expect((await me()).status).toBe(401);

    const again = cookieOf(await post('/api/portal/login', { email: user.email, password: 'clave-nueva-de-maria' }));
    await updateUser(user.id, { disabled: true });
    expect((await fetch(`${base}/api/portal/me`, { headers: { Cookie: again } })).status).toBe(401);
    expect((await post('/api/portal/login', { email: user.email, password: 'clave-nueva-de-maria' })).status).toBe(401);
  });

  it('a cookie changed by hand is no session', async () => {
    const user = await maria();
    const cookie = cookieOf(await post('/api/portal/login', { email: user.email, password: 'clave-de-maria' }));
    const forged = cookie.replace(/\.(\d+)\.(\d+)\./, (_m, v, exp) => `.${Number(v) + 1}.${exp}.`);
    expect((await fetch(`${base}/api/portal/me`, { headers: { Cookie: forged } })).status).toBe(401);
  });

  it('sets the password from an invitation link, says whose it is first, and logs in', async () => {
    const user = await createUser({ email: 'nueva@x.com', name: 'Nueva Persona', grants: [], createdBy: 'oskr814' });
    const { token } = await issueLink(user.id, 'invite');
    expect(await (await post('/api/portal/link', { token })).json()).toEqual({ name: 'Nueva Persona', email: 'nueva@x.com', kind: 'invite' });
    expect((await post('/api/portal/password', { token, password: 'corta' })).status).toBe(400);
    const res = await post('/api/portal/password', { token, password: 'mi clave segura' });
    expect(res.status).toBe(200);
    expect((await fetch(`${base}/api/portal/me`, { headers: { Cookie: cookieOf(res) } })).status).toBe(200);
    // Used up.
    expect((await post('/api/portal/password', { token, password: 'otra clave segura' })).status).toBe(404);
    expect((await post('/api/portal/link', { token })).status).toBe(404);
  });

  it('a forgotten password: a link by email when the account exists, the same answer when it does not', async () => {
    await maria();
    expect((await post('/api/portal/forgot', { email: 'nadie@x.com' })).status).toBe(204);
    expect(send).not.toHaveBeenCalled();
    expect((await post('/api/portal/forgot', { email: 'MFERNANDEZ@redmotoshn.com' })).status).toBe(204);
    expect(send).toHaveBeenCalledOnce();
    const [mail] = send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }];
    expect(mail.to).toBe('mfernandez@redmotoshn.com');
    expect(mail.subject).toMatch(/Cambiar tu contraseña/);
    const token = /#t=([\w-]+)/.exec(mail.text)![1];
    expect(mail.text).toContain(`${PORTAL.url}/contrasena#t=`);
    expect((await (await post('/api/portal/link', { token })).json()).kind).toBe('reset');
  });

  it('answers a body that is not JSON, and a method a path does not take, without reaching the account', async () => {
    const bad = await fetch(`${base}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PORTAL.url }, body: '{no' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('pedido inválido');
    expect((await post('/api/portal/login', [])).status).toBe(400);
    expect((await fetch(`${base}/api/portal/login`)).status).toBe(405);
    expect((await fetch(`${base}/api/portal/nada`)).status).toBe(404);
  });

  it('exports its routes typed, for a client that calls them by name', () => {
    const client = hc<PortalApi>(`${base}/api/portal`);
    expect(client.me.$url().pathname).toBe('/api/portal/me');
    expect(typeof client.requests[':n'].decision.$post).toBe('function');
  });

  it('logs out by dropping the cookie', async () => {
    const res = await post('/api/portal/logout', {});
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^ronin_portal=; Path=\/; Max-Age=0/);
  });
});
