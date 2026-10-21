import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '../../platform/config/config.js';
import { createRequest, getRequest, RequestError, updateRequest, type InterviewQuestion, type PortalRequest } from './requests.js';

vi.mock('../../platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const handOverMail = vi.fn(async (_r: PortalRequest, _u: unknown) => {});
vi.mock('./notify.js', () => ({ handOverMail: (r: PortalRequest, u: unknown) => handOverMail(r, u) }));
vi.mock('./launch.js', () => ({ launchPortalWorker: vi.fn(async () => {}) }));

const { answerInterview, confirmUnderstood, CONFIRMED_REPLY, interviewText, MAX_CORRECTIONS, MAX_INTERVIEW_QUESTIONS, openQuestions, parseQuestions, parseUnderstood, readAnswers, skipInterview, SKIPPED_REPLY, UNSURE } = await import('./interview.js');

const QUESTIONS: InterviewQuestion[] = [
  { id: 'quien', kind: 'one', text: '¿Quién decide qué cliente es mayorista?', options: ['Ventas', 'Administración'], other: true },
  { id: 'donde', kind: 'many', text: '¿Dónde deben verse esos precios?', options: ['En el pedido', 'En la factura', 'En el catálogo'] },
  { id: 'casos', kind: 'text', text: '¿En qué casos lo necesitan?', optional: true },
];

const launch = vi.fn(async (_n: number) => {});

async function interviewing(over: Partial<PortalRequest> = {}): Promise<number> {
  const r = await createRequest({ userId: 'u1', repo: 'acme/tienda', app: 'web', text: 'Precios para mayoristas', images: [] });
  await updateRequest(r.number, (x) => {
    x.messages.push({ id: 2, from: 'ronin', text: 'Respóndeme estas preguntas.', images: [], questions: QUESTIONS, at: new Date().toISOString() });
    x.status = 'interviewing';
    x.interview = { rounds: 1, corrections: 0 };
    x.verdict = { kind: 'big', reason: 'Es una regla de negocio nueva.', summary: 'Lista de precios por tipo de cliente.', at: new Date().toISOString() };
    Object.assign(x, over);
  });
  return r.number;
}

async function confirming(corrections = 0): Promise<number> {
  const n = await interviewing();
  await updateRequest(n, (x) => {
    x.messages.push({ id: 3, from: 'ronin', text: 'Así lo entendí.', images: [], understood: { decisions: [{ topic: 'Quién lo decide', decision: 'Ventas' }], out: [], team: [] }, at: new Date().toISOString() });
    x.status = 'confirming';
    x.interview = { rounds: 1, corrections };
  });
  return n;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  launch.mockClear();
  handOverMail.mockClear();
});

describe('reading the answers', () => {
  it('turns the options picked into words, with "Otra" and "No sé"', () => {
    expect(readAnswers(QUESTIONS, [
      { id: 'quien', other: 'Gerencia' },
      { id: 'donde', choices: [2, 0] },
      { id: 'casos', text: '  Cuando compran por caja  ' },
    ])).toEqual([
      { id: 'quien', question: QUESTIONS[0].text, answer: 'Otra: Gerencia' },
      { id: 'donde', question: QUESTIONS[1].text, answer: 'En el pedido · En el catálogo' },
      { id: 'casos', question: QUESTIONS[2].text, answer: 'Cuando compran por caja' },
    ]);
    expect(readAnswers(QUESTIONS, [{ id: 'quien', unsure: true }, { id: 'donde', choices: [1] }])).toEqual([
      { id: 'quien', question: QUESTIONS[0].text, answer: UNSURE, unsure: true },
      { id: 'donde', question: QUESTIONS[1].text, answer: 'En la factura' },
    ]);
  });

  it('refuses a missing answer, an option that does not exist, "Otra" where not offered, or two answers to a one-option question', () => {
    expect(() => readAnswers(QUESTIONS, [{ id: 'quien', choices: [0] }])).toThrow(/Falta responder: «¿Dónde/);
    expect(() => readAnswers(QUESTIONS, [{ id: 'quien', choices: [5] }, { id: 'donde', choices: [0] }])).toThrow(RequestError);
    expect(() => readAnswers(QUESTIONS, [{ id: 'quien', choices: [0] }, { id: 'donde', other: 'En la web' }])).toThrow(/no acepta otra/);
    expect(() => readAnswers(QUESTIONS, [{ id: 'quien', choices: [0, 1] }, { id: 'donde', choices: [0] }])).toThrow(/solo una/);
    expect(() => readAnswers(QUESTIONS, [{ id: 'quien', choices: [0] }, { id: 'donde', choices: [0] }, { id: 'otra', text: 'x' }])).toThrow(/ninguna pregunta/);
    expect(() => readAnswers(QUESTIONS, 'nada')).toThrow(RequestError);
  });
});

describe('the interview', () => {
  it('shows the last questions only while it waits for the answers', async () => {
    const n = await interviewing();
    expect(openQuestions((await getRequest(n))!)).toEqual(QUESTIONS);
    await updateRequest(n, (x) => { x.status = 'thinking'; });
    expect(openQuestions((await getRequest(n))!)).toEqual([]);
  });

  it('keeps the answers with the note and gives it back to ronin', async () => {
    const n = await interviewing({ worker: { pid: 1, since: '' } });
    const r = await answerInterview(n, { answers: [{ id: 'quien', choices: [0] }, { id: 'donde', unsure: true }], note: ' Es urgente ', images: [] }, launch);
    expect(r.status).toBe('thinking');
    expect(r.worker).toBeUndefined();
    expect(r.messages.at(-1)).toMatchObject({ from: 'person', text: 'Es urgente', answers: [{ id: 'quien', answer: 'Ventas' }, { id: 'donde', answer: UNSURE, unsure: true }] });
    expect(r.events?.at(-1)).toMatchObject({ kind: 'interview', step: 'answered', round: 1 });
    expect(launch).toHaveBeenCalledWith(n);
  });

  it('refuses answers when there are no questions on screen', async () => {
    const n = await interviewing({ status: 'asking' });
    await expect(answerInterview(n, { answers: [], note: '', images: [] }, launch)).rejects.toThrow(/no espera respuestas/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('goes to the team as it came when the person skips the questions', async () => {
    const n = await interviewing();
    const r = await skipInterview(n, launch);
    expect(r.status).toBe('big');
    expect(r.verdict).toMatchObject({ kind: 'big', reason: 'Es una regla de negocio nueva.', summary: 'Lista de precios por tipo de cliente.' });
    expect(r.interview).toMatchObject({ skipped: true });
    expect(r.messages.at(-2)).toMatchObject({ from: 'person', skipped: true });
    expect(r.messages.at(-1)).toMatchObject({ from: 'ronin', text: SKIPPED_REPLY });
    expect(handOverMail).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(n);
  });
});

describe('what ronin understood', () => {
  it('goes to the team once the person confirms it', async () => {
    const n = await confirming();
    const r = await confirmUnderstood(n, true, '', [], launch);
    expect(r.status).toBe('big');
    expect(r.interview).toMatchObject({ confirmed: true });
    expect(r.messages.at(-2)).toMatchObject({ from: 'person', confirmed: true });
    expect(r.messages.at(-1)).toMatchObject({ from: 'ronin', text: CONFIRMED_REPLY });
    expect(r.events?.at(-1)).toMatchObject({ kind: 'interview', step: 'confirmed' });
    expect(handOverMail).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(n);
  });

  it('goes back to ronin with a correction, up to the limit', async () => {
    const n = await confirming();
    const r = await confirmUnderstood(n, false, 'También lo decide administración', [], launch);
    expect(r.status).toBe('thinking');
    expect(r.interview?.corrections).toBe(1);
    expect(r.messages.at(-1)).toMatchObject({ from: 'person', text: 'También lo decide administración' });
    expect(handOverMail).not.toHaveBeenCalled();

    const last = await confirming(MAX_CORRECTIONS);
    await expect(confirmUnderstood(last, false, 'Otra cosa', [], launch)).rejects.toThrow(/no quedan correcciones/);
    await expect(confirmUnderstood(last, false, '  ', [], launch)).rejects.toThrow(/Escribe qué/);
  });

  it('keeps the answers when the person sends it on without confirming the summary', async () => {
    const n = await confirming();
    const r = await skipInterview(n, launch);
    expect(r.status).toBe('big');
    expect(r.interview?.skipped).toBeUndefined();
    expect(r.messages.at(-1)?.text).toBe(CONFIRMED_REPLY);
  });

  it('refuses a confirmation when the request does not wait for one', async () => {
    const n = await interviewing();
    await expect(confirmUnderstood(n, true, '', [], launch)).rejects.toThrow(/no espera tu confirmación/);
  });
});

describe('the questions the agent wrote', () => {
  it('takes the portal’s shape, with unique ids, and leaves out what it cannot show', () => {
    expect(parseQuestions([
      { id: 'quien', tipo: 'una', pregunta: ' ¿Quién  decide? ', ayuda: 'Hoy nadie', opciones: ['Ventas', 'Ventas', ' Administración '], otra: true },
      { id: 'quien', tipo: 'varias', pregunta: '¿Dónde?', opciones: ['Pedido', 'Factura'], opcional: true },
      { id: 'No Vale', tipo: 'texto', pregunta: '¿En qué casos?', ejemplo: 'Cuando…', opciones: ['ignorada'] },
      { tipo: 'una', pregunta: '¿Una sola opción?', opciones: ['Sí'] },
      { tipo: 'escala', pregunta: '¿Del 1 al 5?' },
      { tipo: 'una', opciones: ['a', 'b'] },
      'nada',
    ])).toEqual([
      { id: 'quien', kind: 'one', text: '¿Quién decide?', help: 'Hoy nadie', options: ['Ventas', 'Administración'], other: true },
      { id: 'quien-2', kind: 'many', text: '¿Dónde?', options: ['Pedido', 'Factura'], optional: true },
      { id: 'p3', kind: 'text', text: '¿En qué casos?', example: 'Cuando…' },
    ]);
    expect(parseQuestions('nada')).toEqual([]);
  });

  it('keeps the first ones, up to the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, tipo: 'texto', pregunta: `¿${i}?` }));
    expect(parseQuestions(many).map((q) => q.id)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'].slice(0, MAX_INTERVIEW_QUESTIONS));
  });

  it('reads the form and the answers back to the agent as text', () => {
    expect(interviewText({ text: 'Respóndeme esto.', questions: QUESTIONS })).toBe('Respóndeme esto.\n\n[The form you left them:]\n1. ¿Quién decide qué cliente es mayorista? (options: Ventas | Administración | Otra)\n2. ¿Dónde deben verse esos precios? (options: En el pedido | En la factura | En el catálogo)\n3. ¿En qué casos lo necesitan? (free text) (optional)');
    expect(interviewText({ text: 'Es urgente', answers: [{ id: 'quien', question: '¿Quién?', answer: UNSURE, unsure: true }] })).toBe(`[Their answers to your form:]\n- ¿Quién? → ${UNSURE}\n\n[Anything else they added:] Es urgente`);
    expect(interviewText({ text: 'Hola' })).toBe('Hola');
  });
});

describe('what ronin understood, as the agent wrote it', () => {
  it('takes the decisions, what stays out and what the team decides', () => {
    expect(parseUnderstood({
      decisiones: [{ tema: ' Quién lo decide ', decision: 'Ventas' }, { tema: 'Sin decisión' }, 'nada'],
      fuera: ['La factura', ''], equipo: 'no es lista',
    })).toEqual({ decisions: [{ topic: 'Quién lo decide', decision: 'Ventas' }], out: ['La factura'], team: [] });
  });

  it('is nothing without a decision', () => {
    expect(parseUnderstood({ decisiones: [], fuera: ['x'] })).toBeUndefined();
    expect(parseUnderstood('texto')).toBeUndefined();
  });

  it('reads back to the agent as the summary it showed', () => {
    expect(interviewText({ text: 'Así lo entendí.', understood: { decisions: [{ topic: 'Quién', decision: 'Ventas' }], out: ['La factura'], team: ['Los avisos'] } }))
      .toBe('Así lo entendí.\n[The summary you showed them:]\n- Quién: Ventas\nLeft out: La factura\nFor the team to decide: Los avisos');
  });
});
