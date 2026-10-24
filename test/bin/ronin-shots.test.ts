import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain JS next to ronin-act, without types.
import { allowedUrl, parseScript, targetUrl } from '../../bin/ronin-shots.mjs';

// The prototype's captures from a script (#411): what the agent writes, and
// where its browsers may go.
const browsers = { 'admin-desktop': {}, 'admin-mobile': {} };
const script = (capturas: unknown) => JSON.stringify({ capturas });

describe('ronin-shots', () => {
  it('takes each capture with its browser, number and steps', () => {
    expect(parseScript(script([{ n: 1, navegador: 'admin-desktop', pasos: [
      { ir: '/orders/2' }, { clic: 'role=button[name="Ver"]' }, { escribir: 'role=textbox', texto: 'Ana' }, { esperar: 'text=Pedido' }, { ver: 'role=table' }, { pausa: 300 },
    ] }]), browsers)).toEqual([{ n: 1, browser: 'admin-desktop', steps: [
      { kind: 'ir', target: '/orders/2' }, { kind: 'clic', target: 'role=button[name="Ver"]' }, { kind: 'escribir', target: 'role=textbox', text: 'Ana' },
      { kind: 'esperar', target: 'text=Pedido' }, { kind: 'ver', target: 'role=table' }, { kind: 'pausa', target: 300 },
    ] }]);
  });

  it('refuses a script it could only run half of, saying why', () => {
    expect(() => parseScript('no', browsers)).toThrow('no es JSON');
    expect(() => parseScript(script([]), browsers)).toThrow('"capturas"');
    expect(() => parseScript(script([{ n: 1, navegador: 'ventas-desktop', pasos: [] }]), browsers)).toThrow('hay: admin-desktop, admin-mobile');
    expect(() => parseScript(script([{ n: 0, navegador: 'admin-desktop', pasos: [] }]), browsers)).toThrow('"n" va de 1 a 9');
    expect(() => parseScript(script([{ n: 1, navegador: 'admin-desktop', pasos: [] }, { n: 1, navegador: 'admin-desktop', pasos: [] }]), browsers)).toThrow('repite el número 1');
    expect(() => parseScript(script([{ n: 1, navegador: 'admin-desktop', pasos: [{ arrastrar: 'x' }] }]), browsers)).toThrow('paso 1');
    expect(() => parseScript(script([{ n: 1, navegador: 'admin-desktop', pasos: [{ escribir: 'x' }] }]), browsers)).toThrow('"texto"');
    expect(() => parseScript(script([{ n: 1, navegador: 'admin-desktop', pasos: [{ pausa: 60_000 }] }]), browsers)).toThrow('"pausa"');
  });

  it('goes only to the app and its own services', () => {
    expect(targetUrl('/orders/2', 'http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000/orders/2');
    expect(() => targetUrl('https://example.com/', 'http://127.0.0.1:5000')).toThrow('solo a la app');
    const origins = ['http://127.0.0.1:5000', 'http://127.0.0.1:5001'];
    expect(allowedUrl('http://127.0.0.1:5001/api/orders', origins)).toBe(true);
    expect(allowedUrl('https://example.com/x.png', origins)).toBe(false);
    expect(allowedUrl('data:image/png;base64,AA', origins)).toBe(true);
  });
});
