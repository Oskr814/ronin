import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, updateRequest, updateUnlessClosed, type PortalRequest, type RequestStatus } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

const { parseCloseReason, teamClose } = await import('./team-close.js');

async function request(over: Partial<PortalRequest> = {}): Promise<number> {
  const user = await createUser({ email: `persona${Math.random()}@gmail.com`, name: 'Ana Pérez', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'backoffice', text: 'El total en negrita', images: [] });
  await updateRequest(r.number, (x) => { Object.assign(x, over); });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
});

describe('the team closes a request from the tablero (#404)', () => {
  it('asks for a reason', () => {
    expect(parseCloseReason({ reason: '  Ya existe  ' })).toBe('Ya existe');
    expect(() => parseCloseReason({ reason: ' ' })).toThrow(/motivo/);
    expect(() => parseCloseReason({})).toThrow(/motivo/);
  });

  it('declines it with the reason, which the person gets in the portal and by mail', async () => {
    for (const status of ['thinking', 'asking', 'answered', 'interviewing', 'confirming', 'proposed'] as RequestStatus[]) {
      sendMail.mockClear();
      const n = await request({ status, worker: { pid: 1, since: '' } });
      const closed = await teamClose(n, { reason: 'Esa pantalla se rehace el mes que viene.', by: 'ana-dev' });
      expect(closed, status).toMatchObject({ status: 'declined', closeNote: { text: 'Esa pantalla se rehace el mes que viene.', by: 'ana-dev' } });
      expect(closed.worker).toBeUndefined();
      expect(closed.messages.at(-1)).toMatchObject({ from: 'ronin', text: expect.stringContaining('Esa pantalla se rehace el mes que viene.') });
      expect(closed.events?.find((e) => e.kind === 'closed')).toMatchObject({ status: 'declined', by: 'ana-dev' });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0][0]).toMatchObject({ subject: expect.stringMatching(/^Revisamos tu pedido/), text: expect.stringContaining('Esa pantalla se rehace') });
    }
  });

  it("not with an issue, nor once it's the team's or closed", async () => {
    const withIssue = await request({ status: 'asking', issue: { number: 4, url: 'u' } });
    await expect(teamClose(withIssue, { reason: 'x', by: 'ana-dev' })).rejects.toThrow(/ya no se puede cerrar/);
    for (const status of ['minor', 'reproducing', 'awaiting-dev', 'approved', 'big', 'done', 'declined', 'cancelled'] as RequestStatus[]) {
      const n = await request({ status });
      await expect(teamClose(n, { reason: 'x', by: 'ana-dev' }), status).rejects.toThrow(/ya no se puede cerrar/);
      expect((await getRequest(n))?.status).toBe(status);
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a worker still reading it finishes and leaves it closed', async () => {
    const n = await request({ status: 'thinking' });
    await teamClose(n, { reason: 'No aplica.', by: 'ana-dev' });
    expect(await updateUnlessClosed(n, (r) => { r.status = 'asking'; })).toBeUndefined();
    expect((await getRequest(n))?.status).toBe('declined');
  });
});
