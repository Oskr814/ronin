import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../../core/config.js';
import { createUser, issueLink, redeemLink, updateUser } from '../../../domains/portal/accounts.js';
import { hashPassword } from '../../../domains/portal/password.js';
import { getRequest, updateRequest } from '../../../domains/portal/requests.js';
import { resetPortalLimits } from '../../../domains/portal/routes.js';
import { createPortalHandler } from './portal.js';

vi.mock('../../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('../../../core/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));

const PORTAL = { url: 'https://ronin-agent.example.com', sessionSecret: 'p'.repeat(40), sessionDays: 30, dailyLimit: 2 };
const entries = [{ productRepo: 'redmotos/shoppingcart', productRepoPath: '/x', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice' }, tienda: { name: 'Tienda' } } } }];
const launch = vi.fn(async () => {});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = `data:image/png;base64,${PNG.toString('base64')}`;

let server: Server;
let base: string;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), 'ronin-portal-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html>');
  const handle = createPortalHandler(PORTAL, { webRoot: web, deps: { entries: async () => entries, launch } });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  resetPortalLimits();
  launch.mockClear();
});

async function person(email: string, grants = [{ repo: 'redmotos/shoppingcart', app: 'backoffice' }]) {
  const user = await createUser({ email, name: 'María Fernández', grants, createdBy: 'oskr814' });
  const { token } = await issueLink(user.id, 'invite');
  await redeemLink(token, await hashPassword('clave-de-prueba'));
  const res = await fetch(`${base}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PORTAL.url }, body: JSON.stringify({ email, password: 'clave-de-prueba' }) });
  return { user, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}
const post = (cookie: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PORTAL.url, Cookie: cookie }, body: JSON.stringify(body) });
const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

describe('portal requests API', () => {
  it('opens a request in an app the person has, with images, and starts ronin reading it', async () => {
    const { cookie } = await person('mf@x.com');
    const res = await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Que el nombre del cliente sea un enlace', images: [png] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ number: 1, title: 'Que el nombre del cliente sea un enlace', appName: 'Red Motos · Backoffice', status: 'thinking', messages: [{ from: 'person', images: ['/api/portal/requests/1/images/1-1.png'] }] });
    expect(body).not.toHaveProperty('userId');
    expect(launch).toHaveBeenCalledWith(1);

    const img = await get(cookie, '/api/portal/requests/1/images/1-1.png');
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    expect((await (await get(cookie, '/api/portal/requests')).json()).map((r: { number: number; messages: number }) => [r.number, r.messages])).toEqual([[1, 1]]);
  });

  it('refuses an app the person does not have, and an empty message', async () => {
    const { cookie } = await person('mf@x.com');
    expect((await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'tienda', text: 'x' })).status).toBe(400);
    expect((await (await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: '  ' })).json()).error).toMatch(/Escribe qué necesitas/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a body larger than its images allow, with what the page shows', async () => {
    const { cookie } = await person('mfernandez@redmotoshn.com');
    const res = await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'x'.repeat(30 * 1024 * 1024) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no llegó bien/);
  });

  it('stops at the daily limit, the account’s own when it has one', async () => {
    const { user, cookie } = await person('mf@x.com');
    const open = () => post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'otro' });
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    const third = await open();
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/tope de 2 pedidos/);
    await updateUser(user.id, { dailyLimit: 3 });
    expect((await open()).status).toBe(200);
    expect((await (await get(cookie, '/api/portal/me')).json()).today).toEqual({ used: 3, limit: 3 });
  });

  it('takes an answer only while ronin waits on the person, and starts reading again', async () => {
    const { cookie } = await person('mf@x.com');
    await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Hola' });
    launch.mockClear();
    expect((await post(cookie, '/api/portal/requests/1/messages', { text: 'apuro' })).status).toBe(400);
    await updateRequest(1, (r) => { r.status = 'asking'; });
    const res = await post(cookie, '/api/portal/requests/1/messages', { text: 'En las tres pantallas' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('thinking');
    expect(launch).toHaveBeenCalledWith(1);
    expect((await getRequest(1))?.messages.map((m) => m.text)).toEqual(['Hola', 'En las tres pantallas']);
  });

  it('never shows someone else’s request, nor the team’s summary', async () => {
    const a = await person('mf@x.com');
    await post(a.cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Hola', images: [png] });
    await updateRequest(1, (r) => { r.status = 'minor'; r.verdict = { kind: 'minor', summary: 'ClientInfoPanel.tsx', instruction: 'secreto', at: '' }; });
    expect(JSON.stringify(await (await get(a.cookie, '/api/portal/requests/1')).json())).not.toMatch(/ClientInfoPanel|secreto/);
    const b = await person('otro@x.com');
    for (const path of ['/api/portal/requests/1', '/api/portal/requests/1/images/1-1.png']) expect((await get(b.cookie, path)).status, path).toBe(404);
    expect((await post(b.cookie, '/api/portal/requests/1/messages', { text: 'x' })).status).toBe(404);
    expect(await (await get(b.cookie, '/api/portal/requests')).json()).toEqual([]);
  });

  it('shows the prototype with its captions and the adjustments left, and takes the decision on it', async () => {
    const { cookie } = await person('mf@x.com');
    await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Hola' });
    expect((await post(cookie, '/api/portal/requests/1/decision', { decision: 'aprobar' })).status).toBe(400);
    await updateRequest(1, (r) => {
      r.status = 'proposed';
      r.verdict = { kind: 'minor', proposal: 'p', instruction: 'secreto', summary: 'ClientInfoPanel.tsx', at: '' };
      r.messages.push({ id: 2, from: 'ronin', text: 'Así quedaría', images: ['p1-antes-1.png'], captions: ['Antes: hoy'], at: '' });
      r.prototypes = [{ round: 1, summary: 'Link en ClientInfoPanel', patch: '1.diff', messageId: 2, at: '' }];
    });
    const view = await (await get(cookie, '/api/portal/requests/1')).json();
    expect(view).toMatchObject({ status: 'proposed', adjustmentsLeft: 2, messages: [{}, { images: ['/api/portal/requests/1/images/p1-antes-1.png'], captions: ['Antes: hoy'] }] });
    expect(JSON.stringify(view)).not.toMatch(/ClientInfoPanel|secreto|1\.diff/);
    expect((await post(cookie, '/api/portal/requests/1/decision', { decision: 'quizás' })).status).toBe(400);
    const res = await post(cookie, '/api/portal/requests/1/decision', { decision: 'rechazar', text: 'No era eso' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'big', messages: [{}, {}, { from: 'person', text: 'No era eso' }, { from: 'ronin' }] });
    // Once to read it, once to open the team's issue.
    expect(launch).toHaveBeenCalledTimes(2);
    const other = await person('otro@x.com');
    expect((await post(other.cookie, '/api/portal/requests/1/decision', { decision: 'aprobar' })).status).toBe(404);
  });

  it('shows the interview’s questions, takes the answers, the summary’s confirmation or correction, and skipping it (#225)', async () => {
    const { cookie } = await person('mf@x.com');
    await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Precios para mayoristas' });
    expect((await post(cookie, '/api/portal/requests/1/interview', { answers: [] })).status).toBe(400);
    const questions = [{ id: 'quien', kind: 'one', text: '¿Quién decide?', options: ['Ventas', 'Administración'] }];
    await updateRequest(1, (r) => {
      r.status = 'interviewing';
      r.interview = { rounds: 1, corrections: 0 };
      r.verdict = { kind: 'big', reason: 'Regla nueva', summary: 'PriceListService.cs', at: '' };
      r.messages.push({ id: 2, from: 'ronin', text: 'Respóndeme esto', images: [], questions: questions as never, at: '' });
    });
    const view = await (await get(cookie, '/api/portal/requests/1')).json();
    expect(view).toMatchObject({ status: 'interviewing', interview: { round: 1, rounds: 2, correctionsLeft: 2 }, messages: [{}, { questions }] });
    expect(JSON.stringify(view)).not.toMatch(/PriceListService/);
    const other = await person('otro@x.com');
    expect((await post(other.cookie, '/api/portal/requests/1/interview', { answers: [{ id: 'quien', choices: [0] }] })).status).toBe(404);
    expect((await post(cookie, '/api/portal/requests/1/interview', { answers: [{ id: 'quien', choices: [7] }] })).status).toBe(400);
    const answered = await post(cookie, '/api/portal/requests/1/interview', { answers: [{ id: 'quien', choices: [1] }], note: 'Nada más' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ status: 'thinking', messages: [{}, {}, { from: 'person', text: 'Nada más', answers: [{ id: 'quien', question: '¿Quién decide?', answer: 'Administración' }] }] });
    expect(launch).toHaveBeenCalledTimes(2);

    await updateRequest(1, (r) => {
      r.status = 'confirming';
      r.messages.push({ id: 4, from: 'ronin', text: 'Así lo entendí', images: [], understood: { decisions: [{ topic: 'Quién decide', decision: 'Administración' }], out: [], team: [] }, at: '' });
    });
    expect((await post(cookie, '/api/portal/requests/1/understood', { text: 'x' })).status).toBe(400);
    const corrected = await post(cookie, '/api/portal/requests/1/understood', { ok: false, text: 'También ventas' });
    expect(await corrected.json()).toMatchObject({ status: 'thinking', interview: { correctionsLeft: 1 } });
    await updateRequest(1, (r) => { r.status = 'confirming'; });
    const confirmed = await post(cookie, '/api/portal/requests/1/understood', { ok: true });
    expect(await confirmed.json()).toMatchObject({ status: 'big', messages: [{}, {}, {}, { understood: { decisions: [{ topic: 'Quién decide' }] } }, {}, { confirmed: true }, { from: 'ronin' }] });
    expect((await post(cookie, '/api/portal/requests/1/skip', {})).status).toBe(400);

    await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Otro' });
    await updateRequest(2, (r) => {
      r.status = 'interviewing';
      r.messages.push({ id: 2, from: 'ronin', text: 'Respóndeme esto', images: [], questions: questions as never, at: '' });
    });
    expect(await (await post(cookie, '/api/portal/requests/2/skip', {})).json()).toMatchObject({ status: 'big', messages: [{}, {}, { skipped: true }, { from: 'ronin' }] });
  });

  it('cancels a request while nobody took it, only its owner', async () => {
    const { cookie } = await person('mf@x.com');
    await post(cookie, '/api/portal/requests', { repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Hola' });
    expect(await (await get(cookie, '/api/portal/requests/1')).json()).toMatchObject({ cancellable: true });
    const other = await person('otro@x.com');
    expect((await post(other.cookie, '/api/portal/requests/1/cancel', {})).status).toBe(404);
    const res = await post(cookie, '/api/portal/requests/1/cancel', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', cancellable: false });
    expect((await post(cookie, '/api/portal/requests/1/cancel', {})).status).toBe(400);
    await updateRequest(1, (r) => { r.status = 'approved'; });
    expect(await (await get(cookie, '/api/portal/requests/1')).json()).toMatchObject({ cancellable: false });
  });

  it('asks for a session', async () => {
    expect((await fetch(`${base}/api/portal/requests`)).status).toBe(401);
  });
});
