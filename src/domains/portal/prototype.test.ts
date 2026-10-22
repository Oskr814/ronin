import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@platform/config/config.js';
import type { PrototypeDraft, PrototypeTarget } from './app-run.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, MAX_PROTOTYPES, prototypePatchPath, requestImagePath, updateRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));
const makePrototype = vi.fn();
vi.mock('./app-run.js', async (original) => ({
  ...(await original<typeof import('./app-run.js')>()),
  makePrototype: (...args: unknown[]) => makePrototype(...args),
}));

const { APPROVED_REPLY, decideRequest, FAILED_PROTOTYPE_REPLY, proposedReply, prototypeRequest, REJECTED_REPLY } = await import('./prototype.js');
const { PrototypeDeclined } = await import('./app-run.js');

const shots = mkdtempSync(join(tmpdir(), 'ronin-portal-shots-'));
for (const name of ['antes-1.png', 'despues-1.png', 'despues-2.png']) writeFileSync(join(shots, name), name);

const draft: PrototypeDraft = {
  appName: 'backoffice',
  resumen: 'Envuelve el nombre en un Link.',
  mensaje: 'Ahora el nombre del cliente es un enlace.',
  antes: [{ path: join(shots, 'antes-1.png'), viewport: 'desktop', nota: 'hoy' }],
  despues: [{ path: join(shots, 'despues-1.png'), viewport: 'desktop', nota: 'con el enlace' }, { path: join(shots, 'despues-2.png'), viewport: 'mobile' }],
  patch: 'diff --git a/x b/x\n+<Link>',
};

async function minorRequest() {
  const user = await createUser({ email: 'mf@x.com', name: 'María Fernández', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'El nombre del cliente como enlace', images: [] });
  await updateRequest(r.number, (x) => {
    x.status = 'minor';
    x.verdict = { kind: 'minor', proposal: 'Un enlace', instruction: 'Pedido N° 2, Admin', summary: 'ClientInfoPanel.tsx', at: '' };
  });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
  makePrototype.mockReset();
});

describe('portal prototype', () => {
  it('shows the befores and afters side by side, keeps the diff for the team and tells the person', async () => {
    const n = await minorRequest();
    makePrototype.mockImplementation(async (target: PrototypeTarget, deliver: (d: PrototypeDraft) => Promise<unknown>) => {
      expect(target).toMatchObject({ key: `portal-p-${n}`, appName: 'backoffice' });
      expect(target.task({} as never, { compose: '' })).toMatchObject({ type: 'portal-prototype', requestNumber: n, instruction: 'Pedido N° 2, Admin', round: 1 });
      return deliver(draft);
    });
    await prototypeRequest(n);
    const r = (await getRequest(n))!;
    expect(r.status).toBe('proposed');
    expect(r.worker).toBeUndefined();
    const shown = r.messages.at(-1)!;
    expect(shown).toMatchObject({
      from: 'ronin',
      text: proposedReply(draft.mensaje, 1),
      images: ['p1-antes-1.png', 'p1-despues-1.png', 'p1-despues-2.png'],
      captions: ['Antes: hoy', 'Después: con el enlace', 'Después'],
    });
    expect(await readFile(requestImagePath(n, 'p1-despues-1.png'), 'utf8')).toBe('despues-1.png');
    expect(r.prototypes).toEqual([expect.objectContaining({ round: 1, summary: 'Envuelve el nombre en un Link.', patch: '1.diff', messageId: shown.id })]);
    expect(await readFile(prototypePatchPath(n, '1.diff'), 'utf8')).toContain('+<Link>');
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]).toMatchObject([{ to: 'mf@x.com', subject: expect.stringMatching(/^Tu prototipo está listo/) }, expect.any(String)]);
  });

  it('cancelled while it was being drawn, it is left cancelled and nobody is told', async () => {
    const n = await minorRequest();
    makePrototype.mockImplementation(async (_t: PrototypeTarget, deliver: (d: PrototypeDraft) => Promise<unknown>) => {
      await updateRequest(n, (x) => { x.status = 'cancelled'; });
      return deliver(draft);
    });
    await prototypeRequest(n);
    expect((await getRequest(n))?.status).toBe('cancelled');
    expect((await getRequest(n))?.prototypes).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('counts the adjustments left in its reply', () => {
    expect(proposedReply('Así.', 1)).toContain(`quedan ${MAX_PROTOTYPES - 1} ajustes`);
    expect(proposedReply('Así.', MAX_PROTOTYPES)).toContain('el último ajuste');
  });

  it('tries twice, then hands the request to the team', async () => {
    const n = await minorRequest();
    makePrototype.mockRejectedValue(new Error('docker compose up falló'));
    await prototypeRequest(n);
    expect(makePrototype).toHaveBeenCalledTimes(2);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'big', verdict: { kind: 'big', reason: 'No se pudo armar el prototipo: docker compose up falló', summary: 'ClientInfoPanel.tsx' } });
    expect(r.messages.at(-1)?.text).toBe(FAILED_PROTOTYPE_REPLY);
    // The person hears now; the team, once the worker opened its issue.
    expect(sendMail.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to)).toEqual(['mf@x.com']);
    // Each attempt's failure, the hand-over and its email, in its activity (#132).
    expect((await getRequest(n))?.events?.map((e) => e.kind)).toEqual(['failed', 'failed', 'classified', 'mail']);
    expect((await getRequest(n))?.events?.[0]).toMatchObject({ step: 'prototype', error: 'docker compose up falló' });
  });

  it('when the agent finds no prototype to make, does not try again', async () => {
    const n = await minorRequest();
    makePrototype.mockRejectedValue(new PrototypeDeclined('esa pantalla no existe en esta aplicación'));
    await prototypeRequest(n);
    expect(makePrototype).toHaveBeenCalledOnce();
    expect((await getRequest(n))?.status).toBe('big');
  });

  it('either way the worker opens its issue: approved, for ronin; turned down, for the team, with the person’s note', async () => {
    const approve = await minorRequest();
    const launch = vi.fn(async () => {});
    await expect(decideRequest(approve, 'aprobar', '', launch)).rejects.toThrow(/no espera tu decisión/);
    await updateRequest(approve, (x) => { x.status = 'proposed'; });
    const approved = await decideRequest(approve, 'aprobar', '', launch);
    expect(approved).toMatchObject({ status: 'approved', decision: { kind: 'approved' }, events: [{ kind: 'decided', decision: 'approved' }] });
    expect(approved.messages.at(-1)?.text).toBe(APPROVED_REPLY);
    // The worker opens its issue; nobody is mailed yet.
    expect(launch).toHaveBeenCalledWith(approve);
    expect(sendMail).not.toHaveBeenCalled();

    sendMail.mockClear();
    const reject = (await createRequest({ userId: approved.userId, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Otra', images: [] })).number;
    await updateRequest(reject, (x) => {
      x.status = 'proposed';
      x.verdict = { kind: 'minor', proposal: 'p', instruction: 'i', summary: 's', at: '' };
    });
    launch.mockClear();
    const rejected = await decideRequest(reject, 'rechazar', '  No era esa pantalla  ', launch);
    expect(rejected).toMatchObject({ status: 'big', decision: { kind: 'rejected' }, verdict: { kind: 'big', reason: 'La persona no aprobó el prototipo.', proposal: 'p' } });
    expect(rejected.messages.slice(-2).map((m) => [m.from, m.text])).toEqual([['person', 'No era esa pantalla'], ['ronin', REJECTED_REPLY]]);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(reject);
    await expect(decideRequest(reject, 'aprobar', '', launch)).rejects.toThrow(/no espera tu decisión/);
  });
});
