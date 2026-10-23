import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { addPersonMessage, addRoninMessage, createRequest, getRequest, updateRequest, type PortalRequest, type RequestStatus } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

const { expirePortalRequests, expiry, EXPIRED_ANSWERED_REPLY, expiredReply } = await import('./expire.js');

const H = 3600_000;
const T0 = new Date('2026-10-20T15:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);

// A request ronin left waiting on the person at T0.
async function waiting(status: RequestStatus, over: Partial<PortalRequest> = {}): Promise<number> {
  const user = await createUser({ email: `persona${Math.random()}@gmail.com`, name: 'Ana Pérez', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'backoffice', text: 'El total en negrita', images: [] }, at(-1));
  await updateRequest(r.number, (x) => {
    x.status = status;
    addRoninMessage(x, '¿En qué pantalla?', T0);
    Object.assign(x, over);
  });
  return r.number;
}

// The settings Ajustes changes at runtime.
const portal = config.portal as { remindHours: number; expireHours: number };
const subjects = () => sendMail.mock.calls.map((c) => (c[0] as { subject: string }).subject);

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  portal.remindHours = 12;
  portal.expireHours = 24;
  (config as { exploreTimezone: string }).exploreTimezone = 'America/Tegucigalpa';
  sendMail.mockClear();
});

describe('a request waiting on the person expires (#404)', () => {
  it('reminds once at 12 h, with when it is cancelled, and cancels at 24 h', async () => {
    const n = await waiting('asking');
    await expirePortalRequests(at(11.5));
    expect(sendMail).not.toHaveBeenCalled();

    await expirePortalRequests(at(12));
    expect(subjects()).toEqual([expect.stringMatching(/^Tu pedido espera tu respuesta/)]);
    // 2026-10-21 15:00 UTC, on the team's clock (UTC-6).
    expect((sendMail.mock.calls[0][0] as { text: string }).text).toMatch(/te hizo una pregunta[\s\S]*lo cancelamos el miércoles, 21 de octubre, 09:00/);
    expect((await getRequest(n))?.events?.at(-2)).toMatchObject({ kind: 'reminded' });

    await expirePortalRequests(at(18));
    expect(sendMail).toHaveBeenCalledTimes(1);

    await expirePortalRequests(at(24));
    const r = (await getRequest(n))!;
    expect(r.status).toBe('cancelled');
    expect(r.events?.some((e) => e.kind === 'expired')).toBe(true);
    expect(r.events?.some((e) => e.kind === 'cancelled')).toBe(false);
    expect(r.messages.at(-1)).toMatchObject({ from: 'ronin', text: expiredReply(24) });
    expect(expiredReply(24)).toBe('Cancelamos este pedido porque no tuvimos respuesta en 24 horas. Si todavía lo necesitas, puedes enviar uno nuevo.');
    expect(subjects()[1]).toMatch(/^Cancelamos tu pedido/);

    await expirePortalRequests(at(30));
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('every wait on the person: the question, the form, the summary and the prototype', async () => {
    for (const status of ['asking', 'interviewing', 'confirming', 'proposed'] as RequestStatus[]) {
      const n = await waiting(status);
      await expirePortalRequests(at(12.5));
      await expirePortalRequests(at(24.5));
      expect((await getRequest(n))?.status, status).toBe('cancelled');
    }
    for (const status of ['thinking', 'minor', 'reproducing', 'awaiting-dev', 'approved', 'fixing', 'big', 'done', 'declined'] as RequestStatus[]) {
      const n = await waiting(status);
      await expirePortalRequests(at(100));
      expect((await getRequest(n))?.status, status).toBe(status);
    }
  });

  it('answered: closed at 24 h without a reminder, and without speaking of no answer', async () => {
    const n = await waiting('answered');
    await expirePortalRequests(at(13));
    expect(sendMail).not.toHaveBeenCalled();
    await expirePortalRequests(at(24.2));
    const r = (await getRequest(n))!;
    expect(r.status).toBe('cancelled');
    expect(r.events?.at(-2)).toMatchObject({ kind: 'expired', answered: true });
    expect(r.messages.at(-1)?.text).toBe(EXPIRED_ANSWERED_REPLY);
    expect(subjects()).toEqual([expect.stringMatching(/^Cerramos tu pedido/)]);
    expect((sendMail.mock.calls[0][0] as { text: string }).text).not.toMatch(/respuesta/);
  });

  it('the person answering ends the wait, and ronin asking again starts a new one', async () => {
    const n = await waiting('asking');
    await expirePortalRequests(at(12.5));
    await addPersonMessage(n, 'En la de pedidos', [], at(20));
    await expirePortalRequests(at(25));
    expect((await getRequest(n))?.status).toBe('thinking');
    // ronin asks again at 26 h: a new reminder at 38 h, cancelled at 50 h.
    await updateRequest(n, (r) => {
      r.status = 'asking';
      addRoninMessage(r, '¿Y en qué columna?', at(26));
    });
    sendMail.mockClear();
    await expirePortalRequests(at(37));
    expect(sendMail).not.toHaveBeenCalled();
    await expirePortalRequests(at(38.1));
    expect(subjects()).toEqual([expect.stringMatching(/^Tu pedido espera/)]);
    await expirePortalRequests(at(49));
    expect((await getRequest(n))?.status).toBe('asking');
    await expirePortalRequests(at(50.1));
    expect((await getRequest(n))?.status).toBe('cancelled');
  });

  it('a late reminder keeps the hours it promised: no cancellation without it', async () => {
    // Already waiting 3 days when the tick first sees it.
    const n = await waiting('proposed');
    await expirePortalRequests(at(72));
    expect((await getRequest(n))?.status).toBe('proposed');
    expect(subjects()).toEqual([expect.stringMatching(/^Tu pedido espera/)]);
    expect(expiry((await getRequest(n))!, at(72))?.expiresAt).toEqual(at(84));
    await expirePortalRequests(at(83));
    expect((await getRequest(n))?.status).toBe('proposed');
    await expirePortalRequests(at(84.1));
    expect((await getRequest(n))?.status).toBe('cancelled');
  });

  it('the hours come from the configuration; no reminder when it would come at or after the cancellation', async () => {
    portal.remindHours = 2;
    portal.expireHours = 4;
    const n = await waiting('asking');
    expect(expiry((await getRequest(n))!, T0)).toMatchObject({ remindAt: at(2), expiresAt: at(4), remindedAt: null });
    portal.remindHours = 4;
    expect(expiry((await getRequest(n))!, T0)).toMatchObject({ remindAt: null, expiresAt: at(4) });
    await expirePortalRequests(at(4.1));
    expect((await getRequest(n))?.status).toBe('cancelled');
    expect(subjects()).toEqual([expect.stringMatching(/^Cancelamos/)]);
  });
});
