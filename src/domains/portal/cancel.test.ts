import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createRequest, getRequest, updateRequest, type PortalRequest, type RequestStatus } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const getIssueAssignees = vi.fn(async (_n: number) => [] as string[]);
const closeIssueNotPlanned = vi.fn(async (_n: number, _c: string) => true);
vi.mock('@platform/github/github.js', () => ({
  getIssueAssignees: (n: number) => getIssueAssignees(n),
  closeIssueNotPlanned: (n: number, c: string) => closeIssueNotPlanned(n, c),
}));

const { cancelRequest, CANCELLED_REPLY, TAKEN } = await import('./cancel.js');

const entries = async () => [{ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo' }];

async function request(over: Partial<PortalRequest> = {}): Promise<number> {
  const r = await createRequest({ userId: 'u1', repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Hola', images: [] });
  await updateRequest(r.number, (x) => { Object.assign(x, over); });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  getIssueAssignees.mockReset().mockResolvedValue([]);
  closeIssueNotPlanned.mockClear();
});

describe('cancelling a portal request', () => {
  it('works while nobody took it, and says so in the conversation', async () => {
    for (const status of ['thinking', 'asking', 'answered', 'interviewing', 'confirming', 'minor', 'proposed', 'awaiting-dev', 'big'] as RequestStatus[]) {
      const n = await request({ status, worker: { pid: 1, since: '' } });
      const cancelled = await cancelRequest(n, entries);
      expect(cancelled.status, status).toBe('cancelled');
      expect(cancelled.worker).toBeUndefined();
      expect(cancelled.messages.at(-1)?.text).toBe(CANCELLED_REPLY);
    }
    expect(closeIssueNotPlanned).not.toHaveBeenCalled();
  });

  it('not once approved (its issue is ronin’s) or finished', async () => {
    for (const status of ['approved', 'done', 'resolved', 'declined', 'cancelled'] as RequestStatus[]) {
      const n = await request({ status });
      await expect(cancelRequest(n, entries), status).rejects.toThrow('ya no se puede cancelar');
      expect((await getRequest(n))?.status).toBe(status);
    }
  });

  it("closes the team's issue as not planned while it's unassigned, and refuses once someone took it", async () => {
    const free = await request({ status: 'big', issue: { number: 61, url: 'u' } });
    await cancelRequest(free, entries);
    await vi.waitFor(() => expect(closeIssueNotPlanned).toHaveBeenCalledWith(61, `La persona canceló el pedido P-${free} desde el portal de pedidos.`));
    expect((await getRequest(free))?.status).toBe('cancelled');

    closeIssueNotPlanned.mockClear();
    const taken = await request({ status: 'big', issue: { number: 62, url: 'u' } });
    getIssueAssignees.mockResolvedValue(['dev-ejemplo']);
    await expect(cancelRequest(taken, entries)).rejects.toThrow(TAKEN);
    expect(closeIssueNotPlanned).not.toHaveBeenCalled();
    expect((await getRequest(taken))?.status).toBe('big');
  });

  it('answers before the issue is closed, and a failed close leaves it cancelled (#411)', async () => {
    closeIssueNotPlanned.mockImplementationOnce(() => new Promise(() => {}));
    const n = await request({ status: 'big', issue: { number: 63, url: 'u' } });
    expect((await cancelRequest(n, entries)).status).toBe('cancelled');

    closeIssueNotPlanned.mockRejectedValueOnce(new Error('GitHub caído'));
    const m = await request({ status: 'big', issue: { number: 64, url: 'u' } });
    expect((await cancelRequest(m, entries)).status).toBe('cancelled');
    await vi.waitFor(() => expect(closeIssueNotPlanned).toHaveBeenCalledWith(64, expect.any(String)));
    expect((await getRequest(m))?.status).toBe('cancelled');
  });
});
