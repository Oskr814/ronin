import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { activePriority, byPriority, createRequest, getRequest, prioritizedToday, updateRequest, type PortalRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

const { parsePriority, removePriority } = await import('./priority.js');

const PRIORITY = { impact: 'blocks' as const, reason: 'Sin esto no facturamos', at: '2026-10-24T15:00:00.000Z' };

async function request(over: Partial<PortalRequest> = {}): Promise<PortalRequest> {
  const user = await createUser({ email: `persona${Math.random()}@gmail.com`, name: 'Ana Pérez', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'backoffice', text: 'Filtrar por sucursal', images: [] });
  return updateRequest(r.number, (x) => { Object.assign(x, over); return x; });
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
});

describe('prioritario (#430)', () => {
  it('reads what the person sent, or nothing', () => {
    expect(parsePriority(undefined, '2026-10-24')).toBeUndefined();
    expect(parsePriority({ impact: 'customers', reason: '  Llaman  ' }, '2026-10-24')).toEqual({ impact: 'customers', reason: 'Llaman' });
    expect(parsePriority({ impact: 'deadline', reason: 'Cierre', deadline: '2026-10-24' }, '2026-10-24')).toEqual({ impact: 'deadline', reason: 'Cierre', deadline: '2026-10-24' });
    expect(() => parsePriority({ impact: 'deadline', reason: 'Cierre', deadline: '31/10' }, '2026-10-24')).toThrow(/fecha límite/);
    expect(() => parsePriority({ impact: 'blocks', reason: 'x'.repeat(501) }, '2026-10-24')).toThrow(/500/);
    expect(() => parsePriority('sí', '2026-10-24')).toThrow(/por qué no puede esperar/);
  });

  it('is one while open and not taken away', () => {
    expect(activePriority({ status: 'awaiting-dev', priority: PRIORITY })).toBe(PRIORITY);
    expect(activePriority({ status: 'approved', priority: PRIORITY })).toBe(PRIORITY);
    for (const status of ['done', 'resolved', 'declined', 'cancelled'] as const) expect(activePriority({ status, priority: PRIORITY })).toBeUndefined();
    expect(activePriority({ status: 'awaiting-dev', priority: { ...PRIORITY, removed: { by: 'ana-dev', reason: 'x', at: '' } } })).toBeUndefined();
  });

  it('puts prioritarios first, the nearest deadline first, then the oldest; the rest as they were', () => {
    const rows = [
      { number: 9, priority: null }, { number: 8, priority: {} }, { number: 7, priority: null },
      { number: 6, priority: { deadline: '2026-11-01' } }, { number: 5, priority: {} }, { number: 4, priority: { deadline: '2026-10-30' } },
    ];
    expect(rows.sort(byPriority).map((r) => r.number)).toEqual([4, 6, 5, 8, 9, 7]);
  });

  it('counts the ones the person marked today, even if taken away', async () => {
    const a = await request({ priority: { ...PRIORITY, at: new Date().toISOString(), removed: { by: 'ana-dev', reason: 'x', at: '' } } });
    expect(await prioritizedToday(a.userId)).toBe(1);
    expect(await prioritizedToday(a.userId, new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  });

  it('the team takes it away with a reason the person gets, and it goes on as a normal request', async () => {
    const r = await request({ status: 'awaiting-dev', priority: PRIORITY });
    await expect(removePriority(r.number, { reason: ' ', by: 'ana-dev' })).rejects.toThrow(/motivo/);
    const removed = await removePriority(r.number, { reason: 'Hoy se puede hacer a mano.', by: 'ana-dev' });
    expect(removed).toMatchObject({ status: 'awaiting-dev', priority: { reason: 'Sin esto no facturamos', removed: { by: 'ana-dev', reason: 'Hoy se puede hacer a mano.' } } });
    expect(removed.messages.at(-1)).toMatchObject({ from: 'team', by: 'ana-dev', text: expect.stringContaining('Hoy se puede hacer a mano.') });
    expect(removed.events?.at(-1)).toMatchObject({ kind: 'priority-removed', by: 'ana-dev' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ subject: expect.stringMatching(/El equipo te escribió/), text: expect.stringContaining('Hoy se puede hacer a mano.') });
    await expect(removePriority(r.number, { reason: 'otra vez', by: 'ana-dev' })).rejects.toThrow(/ya no es prioritario/);
    expect(activePriority((await getRequest(r.number))!)).toBeUndefined();
  });
});
