import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, updateRequest, type PortalRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));

const { deciderToken, devDecide, parseDevDecision } = await import('./dev-decision.js');

async function waiting(over: Partial<PortalRequest> = {}): Promise<number> {
  const user = await createUser({ email: `persona${Math.random()}@gmail.com`, name: 'Ana Pérez', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'acme/tienda', app: 'backoffice', text: 'El total en negrita', images: [] });
  await updateRequest(r.number, (x) => {
    x.status = 'awaiting-dev';
    x.verdict = { kind: 'minor', proposal: 'El total en negrita.', summary: 's', at: '' };
    Object.assign(x, over);
  });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  (config.dashboard as { sessionSecret: string }).sessionSecret = 's'.repeat(40);
  sendMail.mockClear();
});

describe("a dev's decision on a request (#353)", () => {
  it('reads the decision, and asks for a reason only to decline it', () => {
    expect(parseDevDecision({ decision: 'deploy' })).toEqual({ decision: 'deploy' });
    expect(parseDevDecision({ decision: 'decline', reason: '  Ya no aplica  ' })).toEqual({ decision: 'decline', reason: 'Ya no aplica' });
    expect(() => parseDevDecision({ decision: 'decline', reason: ' ' })).toThrow(/motivo/);
    expect(() => parseDevDecision({ decision: 'merge' })).toThrow(/deploy, review o decline/);
  });

  it('deploy: approved for ronin, the token sealed until the PR, and the worker opens the issue', async () => {
    const n = await waiting();
    const launch = vi.fn(async () => {});
    const r = await devDecide(n, { decision: 'deploy', by: 'ana-dev', token: 'gho_inventado' }, launch);
    expect(r).toMatchObject({ status: 'approved', devDecision: { kind: 'deploy', by: 'ana-dev' } });
    expect(r.devDecision?.token).not.toContain('gho_inventado');
    expect(deciderToken(r)).toBe('gho_inventado');
    expect(r.events?.at(-1)).toMatchObject({ kind: 'dev-decided', decision: 'deploy', by: 'ana-dev' });
    expect(launch).toHaveBeenCalledWith(n);
    expect(sendMail).not.toHaveBeenCalled();
    await expect(devDecide(n, { decision: 'review', by: 'otro-dev' }, launch)).rejects.toThrow(/ya no espera/);
  });

  it("review: a reported error's fix goes to 'fixing', without a token", async () => {
    const n = await waiting({ bug: { steps: 'pasos', reproductions: [] } });
    const r = await devDecide(n, { decision: 'review', by: 'ana-dev', token: 'gho_inventado' }, vi.fn(async () => {}));
    expect(r.status).toBe('fixing');
    expect(r.devDecision).toEqual({ kind: 'review', by: 'ana-dev', at: expect.any(String) });
  });

  it('decline: closes it with the reason, which the person gets in those words, without an issue', async () => {
    const n = await waiting();
    const launch = vi.fn(async () => {});
    const r = await devDecide(n, { decision: 'decline', reason: 'Ese reporte se va a rehacer el mes que viene.', by: 'ana-dev' }, launch);
    expect(r).toMatchObject({ status: 'declined', closeNote: { text: 'Ese reporte se va a rehacer el mes que viene.', by: 'ana-dev' } });
    expect(r.messages.at(-1)?.text).toContain('Ese reporte se va a rehacer el mes que viene.');
    expect(launch).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledOnce();
    expect((sendMail.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('Ese reporte se va a rehacer el mes que viene.');
    expect((await getRequest(n))?.events?.map((e) => e.kind)).toEqual(['dev-decided', 'closed', 'mail']);
  });

  it('approving it, keeps only the answered points of «Antes de aprobar», never declining (#413)', async () => {
    const answers = [{ question: ' ¿También en el reporte? ', answer: ' Sí, en los dos. ' }, { question: '¿Gris o tachado?', answer: '  ' }, { question: 1, answer: 'x' }];
    expect(parseDevDecision({ decision: 'review', answers })).toEqual({ decision: 'review', answers: [{ question: '¿También en el reporte?', answer: 'Sí, en los dos.' }] });
    expect(parseDevDecision({ decision: 'decline', reason: 'No', answers })).toEqual({ decision: 'decline', reason: 'No' });
    expect(() => parseDevDecision({ decision: 'deploy', answers: 'sí' })).toThrow(/answers/);
    expect(() => parseDevDecision({ decision: 'deploy', answers: Array(11).fill({ question: 'q', answer: 'a' }) })).toThrow(/hasta 10/);
    const n = await waiting();
    const r = await devDecide(n, { decision: 'review', by: 'ana-dev', answers: [{ question: '¿También en el reporte?', answer: 'Sí, en los dos.' }] }, vi.fn(async () => {}));
    expect(r.devDecision).toMatchObject({ kind: 'review', answers: [{ question: '¿También en el reporte?', answer: 'Sí, en los dos.' }] });
  });

  it('deploy needs the session of who decides', async () => {
    const n = await waiting();
    await expect(devDecide(n, { decision: 'deploy', by: 'ana-dev' }, vi.fn(async () => {}))).rejects.toThrow(/sesión de GitHub/);
    expect((await getRequest(n))?.status).toBe('awaiting-dev');
  });
});
