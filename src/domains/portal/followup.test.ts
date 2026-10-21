import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../core/config.js';
import { createRequest, getRequest, updateRequest, type PortalRequest } from './requests.js';

vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
let output: string | Error = '';
const tasks: Array<Record<string, unknown>> = [];
vi.mock('../../core/agent-task.js', () => ({
  runAgentTask: vi.fn(async (task: Record<string, unknown>) => {
    tasks.push(task);
    if (output instanceof Error) throw output;
    await writeFile(task.outputPath as string, output);
  }),
}));
const base = join(tmpdir(), `ronin-followup-${process.pid}`);
vi.mock('../../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/tienda', productRepoPath: '/repo', worktreeBasePath: base }) }));
vi.mock('./accounts.js', () => ({ getUser: async () => ({ id: 'u1', email: 'persona@gmail.com', name: 'Ana Pérez' }) }));
const sendPortalMails = vi.fn(async () => {});
vi.mock('./notify.js', () => ({ handOverMail: vi.fn(async () => {}), sendPortalMails: (...a: unknown[]) => sendPortalMails(...(a as [])) }));

const { followUpRequest, isInterviewFollowUp } = await import('./classify.js');

async function answered(over: Partial<PortalRequest> = {}): Promise<number> {
  const r = await createRequest({ userId: 'u1', repo: 'acme/tienda', app: 'web', text: 'Precios para mayoristas', images: [] });
  await updateRequest(r.number, (x) => {
    x.messages.push(
      { id: 2, from: 'ronin', text: 'Respóndeme esto', images: [], questions: [{ id: 'quien', kind: 'one', text: '¿Quién decide?', options: ['Ventas', 'Gerencia'] }], at: '' },
      { id: 3, from: 'person', text: '', images: [], answers: [{ id: 'quien', question: '¿Quién decide?', answer: 'Gerencia' }], at: '' },
    );
    x.status = 'thinking';
    x.interview = { rounds: 1, corrections: 0 };
    x.verdict = { kind: 'big', reason: 'Regla nueva', summary: 'PriceList es única por empresa', at: '' };
    Object.assign(x, over);
  });
  return r.number;
}

const json = (o: unknown) => JSON.stringify(o);

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  tasks.length = 0;
  output = '';
});

describe('the interview’s answers, read without the code (#225)', () => {
  it('only follows an interview’s answers or a correction to its summary', async () => {
    const r = (await getRequest(await answered()))!;
    expect(isInterviewFollowUp(r)).toBe(true);
    expect(isInterviewFollowUp({ ...r, messages: [...r.messages.slice(0, 2), { id: 3, from: 'person', text: 'No, era otra cosa', images: [], correction: true, at: '' }] })).toBe(true);
    expect(isInterviewFollowUp({ ...r, messages: [...r.messages, { id: 4, from: 'person', text: 'Hola', images: [], at: '' }] })).toBe(false);
    expect(isInterviewFollowUp({ ...r, status: 'asking' })).toBe(false);
    expect(isInterviewFollowUp({ ...r, verdict: { kind: 'big', summary: '', at: '' } })).toBe(false);
    expect(isInterviewFollowUp({ ...r, interview: { rounds: 1, corrections: 0, skipped: true } })).toBe(false);
  });

  it('shows the summary from the analysis already made, on its own task, without a checkout', async () => {
    const n = await answered();
    output = json({ accion: 'grande', mensaje: 'Así lo entendí.', resumen: 'PriceList por cliente', entendido: { decisiones: [{ tema: 'Quién decide', decision: 'Gerencia' }], fuera: [], equipo: [] } });
    expect(await followUpRequest(n)).toBe(true);
    expect(tasks[0]).toMatchObject({ type: 'portal-interview', analysis: 'PriceList es única por empresa', reason: 'Regla nueva', roundsLeft: 1 });
    expect(String(tasks[0].dir)).toContain(base);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'confirming', verdict: { summary: 'PriceList por cliente' } });
    expect(r.messages.at(-1)?.understood?.decisions).toEqual([{ topic: 'Quién decide', decision: 'Gerencia' }]);
    expect(sendPortalMails).toHaveBeenCalled();
  });

  it('leaves it to the full read when the answers change the request, or this read fails', async () => {
    const n = await answered();
    output = json({ accion: 'revisar', mensaje: 'Lo miro de nuevo.' });
    expect(await followUpRequest(n)).toBe(false);
    output = json({ accion: 'menor', mensaje: 'Es chico.', propuesta: 'p', instruccion: 'i' });
    expect(await followUpRequest(n)).toBe(false);
    output = new Error('se cortó');
    expect(await followUpRequest(n)).toBe(false);
    expect((await getRequest(n))!.status).toBe('thinking');
    const plain = await answered({ messages: [{ id: 1, from: 'person', text: 'Hola', images: [], at: '' }] });
    expect(await followUpRequest(plain)).toBe(false);
    expect(tasks).toHaveLength(3);
  });
});
