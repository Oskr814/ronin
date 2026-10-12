import { describe, it, expect } from 'vitest';
import { capCandidates, parseCandidate, parseFunctionResult, parseVerdicts, renderFindingBody, type Candidate } from './exploration-output.js';

const out = '/w/exploration-out/run-1/pedidos.confirmar';

function raw(overrides: Record<string, unknown> = {}) {
  return {
    tipo: 'hallazgo',
    titulo: 'Doble toque en Confirmar crea dos pedidos',
    senal: 'bug',
    gravedad: 'bug',
    viewport: 'mobile',
    huella: 'pedidos.confirmar|doble-toque|pedido-duplicado',
    pasos: ['Abrir un pedido creado', 'Tocar Confirmar dos veces rápido'],
    observado: 'Aparecen dos pedidos confirmados',
    esperado: 'Uno solo',
    evidencia: [{ tipo: 'screenshot', detalle: 'mobile/despues.png', nota: 'dos filas' }, { tipo: 'red', detalle: 'POST /Orders/Confirm x2' }],
    propuesta: 'Deshabilitar el botón mientras se confirma',
    ...overrides,
  };
}

describe('parseCandidate', () => {
  it('accepts a complete finding and resolves screenshot paths inside the output dir', () => {
    const c = parseCandidate(raw(), 'pedidos.confirmar', out);
    expect(c.evidencia[0]).toEqual({ tipo: 'screenshot', detalle: `${out}/mobile/despues.png`, nota: 'dos filas' });
    expect(c.huella).toBe('pedidos.confirmar|doble-toque|pedido-duplicado');
  });

  it('never lets a path escape the output dir', () => {
    const c = parseCandidate(raw({ evidencia: [{ tipo: 'screenshot', detalle: '../../../../.env' }, { tipo: 'consola', detalle: 'TypeError' }], mockup: '/etc/passwd' }), 'pedidos.confirmar', out);
    expect(c.evidencia).toEqual([{ tipo: 'consola', detalle: 'TypeError' }]);
    expect(c.mockup).toBeUndefined();
  });

  it('prefixes the function id to the huella when the agent left it out', () => {
    expect(parseCandidate(raw({ huella: 'doble-toque|duplicado' }), 'pedidos.confirmar', out).huella).toBe('pedidos.confirmar|doble-toque|duplicado');
  });

  it('rejects a finding without steps or without evidence', () => {
    expect(() => parseCandidate(raw({ pasos: [] }), 'f', out)).toThrow(/pasos/);
    expect(() => parseCandidate(raw({ evidencia: [] }), 'f', out)).toThrow(/evidencia/);
  });

  it('rejects an idea without a mockup and forces its severity to pulido', () => {
    expect(() => parseCandidate(raw({ tipo: 'idea', mockup: undefined }), 'f', out)).toThrow(/mockup/);
    const idea = parseCandidate(raw({ tipo: 'idea', mockup: 'idea.html', pasos: [], evidencia: [], gravedad: 'bug' }), 'f', out);
    expect(idea).toMatchObject({ senal: 'idea', gravedad: 'pulido', mockup: `${out}/idea.html` });
  });

  it('rejects unknown enums', () => {
    expect(() => parseCandidate(raw({ senal: 'feo' }), 'f', out)).toThrow(/senal/);
    expect(() => parseCandidate(raw({ viewport: 'tablet' }), 'f', out)).toThrow(/viewport/);
  });
});

describe('parseFunctionResult', () => {
  it('keeps valid candidates and reports why the rest were dropped', () => {
    const { result, dropped } = parseFunctionResult(JSON.stringify({
      tareas: [{ viewport: 'desktop', tarea: 'Confirmar un pedido', completada: true, pasos: 6 }, { viewport: 'tv' }],
      candidatos: [raw(), raw({ evidencia: [] })],
    }), 'pedidos.confirmar', out);
    expect(result.tareas).toEqual([{ viewport: 'desktop', tarea: 'Confirmar un pedido', completada: true, pasos: 6 }]);
    expect(result.candidatos).toHaveLength(1);
    expect(dropped).toEqual(['candidato 1: un hallazgo necesita evidencia observada usando la app']);
  });
});

describe('parseVerdicts', () => {
  it('drops whatever got no verdict, and ignores out-of-range or malformed entries', () => {
    const verdicts = parseVerdicts(JSON.stringify({ veredictos: [
      { index: 0, veredicto: 'mantener', motivo: 'reproducido', gravedad: 'lenta' },
      { index: 5, veredicto: 'mantener' },
      { index: 1, veredicto: 'quizas' },
    ] }), 3);
    expect(verdicts).toEqual([
      { index: 0, veredicto: 'mantener', motivo: 'reproducido', gravedad: 'lenta' },
      { index: 1, veredicto: 'descartar', motivo: 'el evaluador no dio veredicto' },
      { index: 2, veredicto: 'descartar', motivo: 'el evaluador no dio veredicto' },
    ]);
  });
});

describe('capCandidates', () => {
  it('keeps the most severe findings first and never lets ideas take their place', () => {
    const items = [
      { id: 1, tipo: 'hallazgo', gravedad: 'pulido' },
      { id: 2, tipo: 'idea', gravedad: 'pulido' },
      { id: 3, tipo: 'hallazgo', gravedad: 'bug' },
      { id: 4, tipo: 'hallazgo', gravedad: 'lenta' },
      { id: 5, tipo: 'idea', gravedad: 'pulido' },
    ] as Array<Pick<Candidate, 'tipo' | 'gravedad'> & { id: number }>;
    const { kept, cut } = capCandidates(items, 2, 1);
    expect(kept.map((k) => k.id)).toEqual([3, 4, 2]);
    expect(cut.map((k) => k.id)).toEqual([1, 5]);
  });
});

describe('renderFindingBody', () => {
  it('renders steps, evidence without image paths, the proposal and the draft patch', () => {
    const body = renderFindingBody(parseCandidate(raw(), 'pedidos.confirmar', out), { functionName: 'Confirmar pedido', patch: '-a\n+b' });
    expect(body).toContain('1. Abrir un pedido creado');
    expect(body).toContain('- red: POST /Orders/Confirm x2');
    expect(body).toContain('1 captura(s) en el mockup: dos filas');
    expect(body).not.toContain('despues.png');
    expect(body).toContain('```diff\n-a\n+b\n```');
  });
});
