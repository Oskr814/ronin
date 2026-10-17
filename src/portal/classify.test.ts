import { describe, it, expect, vi } from 'vitest';
import { applyResult, MAX_QUESTIONS, NEXT_STEP, parsePortalResult } from './classify.js';
import { MAX_PROTOTYPES, type PortalRequest } from './requests.js';

vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

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

  it('a question past the limit goes to the team', () => {
    expect(parsePortalResult(json({ accion: 'preguntar', mensaje: '¿Y otra cosa?' }), MAX_QUESTIONS)).toMatchObject({ accion: 'grande' });
    expect(parsePortalResult(json({ accion: 'preguntar', mensaje: '¿Y otra cosa?' }), MAX_QUESTIONS - 1).accion).toBe('preguntar');
  });
});

describe('applyResult', () => {
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

  it('a big one goes to the team with its reason', () => {
    const r = request();
    applyResult(r, { accion: 'grande', mensaje: 'Esto cambia cómo se guardan los catálogos.', motivo: 'Cambia el servidor', resumen: 'PUT /catalogos' });
    expect(r).toMatchObject({ status: 'big', verdict: { kind: 'big', reason: 'Cambia el servidor', summary: 'PUT /catalogos' } });
    expect(r.messages.at(-1)?.text).toContain(NEXT_STEP.grande);
  });
});
