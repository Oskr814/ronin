import { describe, it, expect, vi } from 'vitest';
import { applyResult, MAX_QUESTIONS, NEXT_STEP, parsePortalResult } from './classify.js';
import { MAX_ROUNDS } from './interview.js';
import { MAX_PROTOTYPES, MAX_REPRODUCTIONS, type PortalRequest } from './requests.js';

vi.mock('../../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const request = (): PortalRequest => ({
  number: 7, userId: 'u1', repo: 'redmotos/shoppingcart', app: 'backoffice', title: 'Quiero abrir la ficha del cliente desde el pedido…', status: 'thinking',
  messages: [{ id: 1, from: 'person', text: 'Quiero abrir la ficha del cliente desde el pedido', images: [], at: '2026-10-17T10:00:00Z' }],
  questions: 0, worker: { pid: 1, since: '2026-10-17T10:00:00Z' }, createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z',
});
const json = (o: unknown) => JSON.stringify(o);

describe('parsePortalResult', () => {
  it('takes the four actions and trims what it keeps', () => {
    expect(parsePortalResult(json({ accion: 'preguntar', mensaje: ' ¿En qué pantalla? ', titulo: 'Ficha del cliente' }), 0)).toEqual({ accion: 'preguntar', mensaje: '¿En qué pantalla?', titulo: 'Ficha del cliente' });
    expect(parsePortalResult(json({ accion: 'responder', mensaje: 'Ya existe: está en Clientes.' }), 0).accion).toBe('responder');
  });

  it('refuses a result without a message or with an unknown action', () => {
    expect(() => parsePortalResult(json({ accion: 'menor' }), 0)).toThrow(/mensaje/);
    expect(() => parsePortalResult(json({ accion: 'hacerlo', mensaje: 'ok' }), 0)).toThrow(/accion/);
    expect(() => parsePortalResult('no es json', 0)).toThrow();
  });

  it('a small change without what the prototype needs goes to the team', () => {
    expect(parsePortalResult(json({ accion: 'menor', mensaje: 'Sí se puede.', propuesta: 'Un enlace' }), 0)).toMatchObject({ accion: 'grande', motivo: expect.any(String) });
  });

  it('an error needs its steps to reproduce it, and goes to the team once out of tries (#137)', () => {
    expect(parsePortalResult(json({ accion: 'error', mensaje: 'Gracias por avisar.', pasos: 'Sales, Gestionar Pedidos, hasta 16/10' }), 0)).toMatchObject({ accion: 'error', pasos: 'Sales, Gestionar Pedidos, hasta 16/10' });
    expect(parsePortalResult(json({ accion: 'error', mensaje: 'Gracias por avisar.' }), 0)).toMatchObject({ accion: 'grande', motivo: 'No quedó claro cómo reproducir el error.' });
    expect(parsePortalResult(json({ accion: 'error', mensaje: 'Va otra vez.', pasos: 'p' }), 1, 0, MAX_REPRODUCTIONS - 1).accion).toBe('error');
    expect(parsePortalResult(json({ accion: 'error', mensaje: 'Va otra vez.', pasos: 'p' }), 1, 0, MAX_REPRODUCTIONS)).toMatchObject({ accion: 'grande', motivo: 'No se pudo reproducir con datos de prueba.' });
  });

  it('a question past the limit goes to the team', () => {
    expect(parsePortalResult(json({ accion: 'preguntar', mensaje: '¿Y otra cosa?' }), MAX_QUESTIONS)).toMatchObject({ accion: 'grande' });
    expect(parsePortalResult(json({ accion: 'preguntar', mensaje: '¿Y otra cosa?' }), MAX_QUESTIONS - 1).accion).toBe('preguntar');
  });
});

describe('parsePortalResult — the interview (#225)', () => {
  const preguntas = [{ id: 'quien', tipo: 'una', pregunta: '¿Quién decide?', opciones: ['Ventas', 'Administración'] }];

  it('keeps the questions in the portal’s shape', () => {
    expect(parsePortalResult(json({ accion: 'entrevistar', mensaje: 'Es más que un ajuste.', motivo: 'Regla nueva', resumen: 'PriceList', preguntas }), 0)).toMatchObject({
      accion: 'entrevistar', motivo: 'Regla nueva', preguntas: [{ id: 'quien', kind: 'one', text: '¿Quién decide?', options: ['Ventas', 'Administración'] }],
    });
  });

  it('goes to the team without usable questions, or past its rounds', () => {
    expect(parsePortalResult(json({ accion: 'entrevistar', mensaje: 'x', preguntas: [{ tipo: 'una', pregunta: '¿Sí?', opciones: ['Sí'] }] }), 0)).toMatchObject({ accion: 'grande', motivo: expect.any(String) });
    expect(parsePortalResult(json({ accion: 'entrevistar', mensaje: 'x', motivo: 'Regla nueva', preguntas }), 0, 0, 0, MAX_ROUNDS)).toMatchObject({ accion: 'grande', motivo: 'Regla nueva' });
    expect(parsePortalResult(json({ accion: 'entrevistar', mensaje: 'x', preguntas }), 0, 0, 0, MAX_ROUNDS - 1).accion).toBe('entrevistar');
  });
});

describe('parsePortalResult — the summary after the interview (#225)', () => {
  const entendido = { decisiones: [{ tema: 'Quién decide', decision: 'Ventas' }], fuera: [], equipo: ['Los avisos'] };

  it('keeps it only after an interview', () => {
    expect(parsePortalResult(json({ accion: 'grande', mensaje: 'Así lo entendí.', entendido }), 0, 0, 0, 1).entendido).toEqual({ decisions: [{ topic: 'Quién decide', decision: 'Ventas' }], out: [], team: ['Los avisos'] });
    expect(parsePortalResult(json({ accion: 'grande', mensaje: 'Es grande.', entendido }), 0).entendido).toBeUndefined();
    expect(parsePortalResult(json({ accion: 'grande', mensaje: 'Así lo entendí.', entendido: { decisiones: [] } }), 0, 0, 0, 1).entendido).toBeUndefined();
  });
});

describe('applyResult', () => {
  it('an interview leaves the questions in ronin’s message and waits on the person, already big (#225)', () => {
    const r = request();
    const preguntas = [{ id: 'quien', kind: 'one' as const, text: '¿Quién decide?', options: ['Ventas', 'Administración'] }];
    applyResult(r, { accion: 'entrevistar', mensaje: 'Es más que un ajuste: respóndeme esto.', titulo: 'Precios para mayoristas', motivo: 'Regla nueva', resumen: 'PriceList', preguntas });
    expect(r).toMatchObject({ status: 'interviewing', title: 'Precios para mayoristas', interview: { rounds: 1, corrections: 0 }, verdict: { kind: 'big', reason: 'Regla nueva', summary: 'PriceList' } });
    expect(r.worker).toBeUndefined();
    expect(r.messages.at(-1)).toMatchObject({ from: 'ronin', text: 'Es más que un ajuste: respóndeme esto.', questions: preguntas });
    expect(r.events?.at(-1)).toMatchObject({ kind: 'interview', step: 'asked', round: 1 });
    // With the answers, to the team saying so.
    applyResult(r, { accion: 'grande', mensaje: 'Gracias.', resumen: 'PriceList, con las respuestas' });
    expect(r).toMatchObject({ status: 'big', verdict: { kind: 'big', summary: 'PriceList, con las respuestas' } });
    expect(r.messages.at(-1)?.text).toBe(`Gracias.\n\n${NEXT_STEP.entrevistado}`);
  });

  it('after the interview, shows what it understood for the person to confirm (#225)', () => {
    const r = { ...request(), status: 'thinking' as const, interview: { rounds: 1, corrections: 0 }, verdict: { kind: 'big' as const, reason: 'Regla nueva', summary: 'PriceList', at: '' } };
    const entendido = { decisions: [{ topic: 'Quién decide', decision: 'Ventas' }], out: [], team: [] };
    applyResult(r, { accion: 'grande', mensaje: 'Así entendí lo que necesitas.', resumen: 'PriceList, con las respuestas', entendido });
    expect(r).toMatchObject({ status: 'confirming', verdict: { kind: 'big', reason: 'Regla nueva', summary: 'PriceList, con las respuestas' } });
    expect(r.messages.at(-1)).toMatchObject({ from: 'ronin', text: 'Así entendí lo que necesitas.', understood: entendido });
    expect(r.events?.at(-1)).toMatchObject({ kind: 'interview', step: 'summary', round: 1 });
    // Without a summary, or once the questions were skipped, straight to the team.
    const skipped = { ...request(), interview: { rounds: 1, corrections: 0, skipped: true as const } };
    applyResult(skipped, { accion: 'grande', mensaje: 'Va al equipo.', entendido });
    expect(skipped.status).toBe('big');
  });

  it('a question waits on the person, counts, and names the request', () => {
    const r = request();
    applyResult(r, { accion: 'preguntar', mensaje: '¿En las tres pantallas?', titulo: 'Abrir la ficha del cliente desde un pedido' });
    expect(r).toMatchObject({ status: 'asking', questions: 1, title: 'Abrir la ficha del cliente desde un pedido' });
    expect(r.worker).toBeUndefined();
    expect(r.messages.at(-1)).toMatchObject({ id: 2, from: 'ronin', text: '¿En las tres pantallas?' });
    // Only the first reply names it.
    applyResult(r, { accion: 'responder', mensaje: 'Listo.', titulo: 'Otro título' });
    expect(r).toMatchObject({ status: 'answered', title: 'Abrir la ficha del cliente desde un pedido' });
  });

  it('a small change keeps the proposal and the instruction, and says the prototype comes next', () => {
    const r = request();
    applyResult(r, { accion: 'menor', mensaje: 'Se puede.', propuesta: 'El nombre del cliente pasa a ser un enlace.', instruccion: 'Pedido N° 2, desktop, Admin', resumen: 'ClientInfoPanel.tsx' });
    expect(r.status).toBe('minor');
    expect(r.verdict).toMatchObject({ kind: 'minor', proposal: 'El nombre del cliente pasa a ser un enlace.', instruction: 'Pedido N° 2, desktop, Admin', summary: 'ClientInfoPanel.tsx' });
    expect(r.messages.at(-1)?.text).toBe(`Se puede.\n\nLa propuesta: El nombre del cliente pasa a ser un enlace.\n\n${NEXT_STEP.menor}`);
  });

  it('past the prototypes allowed, another small change goes to the team', () => {
    expect(parsePortalResult(json({ accion: 'menor', mensaje: 'Otro', propuesta: 'p', instruccion: 'i' }), 0, MAX_PROTOTYPES)).toMatchObject({ accion: 'grande' });
    expect(parsePortalResult(json({ accion: 'menor', mensaje: 'Otro', propuesta: 'p', instruccion: 'i' }), 0, MAX_PROTOTYPES - 1)).toMatchObject({ accion: 'menor' });
  });

  it('with a prototype on screen, an answer leaves it there to decide on, and an adjustment draws another', () => {
    const shown = (): PortalRequest => ({
      ...request(), status: 'thinking',
      verdict: { kind: 'minor', proposal: 'p', instruction: 'i', summary: '', at: '' },
      prototypes: [{ round: 1, summary: 's', messageId: 2, at: '' }],
    });
    const asked = shown();
    applyResult(asked, { accion: 'responder', mensaje: 'Sí, también en el celular.' });
    expect(asked.status).toBe('proposed');
    const adjusted = shown();
    applyResult(adjusted, { accion: 'menor', mensaje: 'Va.', propuesta: 'Más grande', instruccion: 'i2' });
    expect(adjusted).toMatchObject({ status: 'minor', verdict: { instruction: 'i2' } });
    expect(adjusted.messages.at(-1)?.text).toContain(NEXT_STEP.otra);
  });

  it('an error is reproduced next, keeping the tries before it (#137)', () => {
    const r = request();
    applyResult(r, { accion: 'error', mensaje: 'Gracias por avisar.', pasos: 'Sales, Gestionar Pedidos, hasta 16/10: faltan los del 16', resumen: 'FilterByDateRange' });
    expect(r).toMatchObject({ status: 'reproducing', verdict: { kind: 'error', summary: 'FilterByDateRange' }, bug: { steps: 'Sales, Gestionar Pedidos, hasta 16/10: faltan los del 16', reproductions: [] }, events: [{ kind: 'classified', verdict: 'error' }] });
    expect(r.worker).toBeUndefined();
    expect(r.messages.at(-1)?.text).toBe(`Gracias por avisar.\n\n${NEXT_STEP.error}`);
    const again = request();
    again.bug = { steps: 'antes', reproductions: [{ round: 1, reproduced: false, steps: [], summary: 's', messageId: 2, at: '' }] };
    applyResult(again, { accion: 'error', mensaje: 'Lo intento con el 1498.', pasos: 'el pedido 1498' });
    expect(again.bug).toMatchObject({ steps: 'el pedido 1498', reproductions: [{ round: 1 }] });
  });

  it('a big one goes to the team with its reason', () => {
    const r = request();
    applyResult(r, { accion: 'grande', mensaje: 'Esto cambia cómo se guardan los catálogos.', motivo: 'Cambia el servidor', resumen: 'PUT /catalogos' });
    expect(r).toMatchObject({ status: 'big', verdict: { kind: 'big', reason: 'Cambia el servidor', summary: 'PUT /catalogos' }, events: [{ kind: 'classified', verdict: 'big' }] });
    expect(r.messages.at(-1)?.text).toContain(NEXT_STEP.grande);
  });
});
