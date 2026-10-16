import { describe, it, expect } from 'vitest';
import { capCandidates, clip, parseCandidate, parseFindingBody, parseFunctionResult, parseRedoResult, parseVerdicts, renderFindingBody, replaceAfterImage, replaceDraftPatch, replaceProposal, type Candidate } from './output.js';

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
    const c = parseCandidate(raw({ evidencia: [{ tipo: 'screenshot', detalle: '../../../../.env' }, { tipo: 'consola', detalle: 'TypeError' }], despues: { imagen: '/etc/passwd.png' } }), 'pedidos.confirmar', out);
    expect(c.evidencia).toEqual([{ tipo: 'consola', detalle: 'TypeError' }]);
    expect(c.despues).toBeUndefined();
  });

  it('keeps a title a bit over the 120 the prompt asks for whole', () => {
    const titulo = "En el teléfono, el desglose de pagos muestra solo la fecha: el monto y la referencia quedan fuera de pantalla, y también el pendiente de la factura";
    expect(titulo.length).toBe(147);
    expect(parseCandidate(raw({ titulo }), 'pedidos.confirmar', out).titulo).toBe(titulo);
  });

  it('prefixes the function id to the huella when the agent left it out', () => {
    expect(parseCandidate(raw({ huella: 'doble-toque|duplicado' }), 'pedidos.confirmar', out).huella).toBe('pedidos.confirmar|doble-toque|duplicado');
  });

  it('rejects a finding without steps or without evidence', () => {
    expect(() => parseCandidate(raw({ pasos: [] }), 'f', out)).toThrow(/pasos/);
    expect(() => parseCandidate(raw({ evidencia: [] }), 'f', out)).toThrow(/evidencia/);
  });

  it('rejects an idea without an after image and forces its severity to pulido', () => {
    expect(() => parseCandidate(raw({ tipo: 'idea' }), 'f', out)).toThrow(/después/);
    expect(() => parseCandidate(raw({ tipo: 'idea', despues: { imagen: 'despues/idea.txt' } }), 'f', out)).toThrow(/después/);
    const idea = parseCandidate(raw({ tipo: 'idea', despues: { imagen: 'despues/idea.html', nota: 'con escáner' }, pasos: [], evidencia: [], gravedad: 'bug' }), 'f', out);
    expect(idea).toMatchObject({ senal: 'idea', gravedad: 'pulido', despues: { imagen: `${out}/despues/idea.html`, nota: 'con escáner' } });
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
  it('renders steps, evidence, the proposal and the draft patch, captions only when there are no images', () => {
    const body = renderFindingBody(parseCandidate(raw(), 'pedidos.confirmar', out), { functionName: 'Confirmar pedido', patch: '-a\n+b' });
    expect(body).toContain('1. Abrir un pedido creado');
    expect(body).toContain('- red: POST /Orders/Confirm x2');
    expect(body).toContain('- captura: dos filas');
    expect(body).not.toContain('despues.png');
    expect(body).not.toContain('<img');
    expect(body).toContain('```diff\n-a\n+b\n```');
  });

  it('shows the published before and after images, sized for the viewport', () => {
    const body = renderFindingBody(parseCandidate(raw(), 'pedidos.confirmar', out), {
      functionName: 'Confirmar pedido',
      antes: [{ url: 'https://github.com/o/r/blob/abc/a.png?raw=true', nota: 'dos filas' }],
      despues: { url: 'https://github.com/o/r/blob/abc/d.png?raw=true', nota: 'botón deshabilitado' },
    });
    expect(body).toContain('**Antes**: dos filas\n\n<img src="https://github.com/o/r/blob/abc/a.png?raw=true" alt="dos filas" width="320">');
    expect(body).toContain('**Después**: botón deshabilitado\n\n<img src="https://github.com/o/r/blob/abc/d.png?raw=true"');
    expect(body).not.toContain('- captura');
    expect(body.indexOf('### Propuesta')).toBeLessThan(body.indexOf('**Después**'));
  });
});

describe('parseFindingBody', () => {
  const A = 'https://github.com/o/r/blob/abc/a.png?raw=true';
  const D = 'https://github.com/o/r/blob/abc/d.png?raw=true';
  const rendered = () => renderFindingBody(parseCandidate(raw(), 'pedidos.confirmar', out), {
    functionName: 'Confirmar pedido',
    patch: '-a\n+b',
    antes: [{ url: A, nota: 'dos filas' }, { url: 'https://github.com/o/r/blob/abc/a2.png?raw=true' }],
    despues: { url: D, nota: 'botón deshabilitado' },
  });

  it('reads back every part renderFindingBody writes', () => {
    expect(parseFindingBody(rendered())).toEqual({
      functionName: 'Confirmar pedido',
      pasos: ['Abrir un pedido creado', 'Tocar Confirmar dos veces rápido'],
      observado: 'Aparecen dos pedidos confirmados',
      esperado: 'Uno solo',
      evidencia: [{ tipo: 'red', detalle: 'POST /Orders/Confirm x2' }],
      antes: [{ url: A, nota: 'dos filas' }, { url: 'https://github.com/o/r/blob/abc/a2.png?raw=true' }],
      propuesta: 'Deshabilitar el botón mientras se confirma',
      despues: { url: D, nota: 'botón deshabilitado' },
      parche: '-a\n+b',
    });
  });

  it('keeps up with an edited proposal, a redone after and a new patch', () => {
    const body = replaceDraftPatch(replaceAfterImage(replaceProposal(rendered(), 'Mostrar un aviso\n\ny bloquear el botón'), { url: 'https://github.com/o/r/blob/def/d.png?raw=true' }, 'mobile'), '+c');
    const parts = parseFindingBody(body);
    expect(parts.propuesta).toBe('Mostrar un aviso\n\ny bloquear el botón');
    expect(parts.despues).toEqual({ url: 'https://github.com/o/r/blob/def/d.png?raw=true' });
    expect(parts.parche).toBe('+c');
  });

  it('leaves empty what an idea without steps or images does not have', () => {
    const idea = parseCandidate(raw({ tipo: 'idea', senal: 'idea', pasos: [], observado: '', esperado: '', evidencia: [], despues: { imagen: 'd.html' } }), 'pedidos.confirmar', out);
    const parts = parseFindingBody(renderFindingBody(idea, { functionName: 'Confirmar pedido' }));
    expect(parts).toMatchObject({ functionName: 'Confirmar pedido', pasos: [], observado: '', esperado: '', evidencia: [], antes: [], propuesta: 'Deshabilitar el botón mientras se confirma' });
    expect(parts.despues).toBeUndefined();
    expect(parts.parche).toBeUndefined();
  });

  it('keeps a multi-paragraph observation whole', () => {
    const c = parseCandidate(raw({ observado: 'Primero esto.\n\nDespués aquello.' }), 'pedidos.confirmar', out);
    expect(parseFindingBody(renderFindingBody(c, { functionName: 'Confirmar pedido' })).observado).toBe('Primero esto.\n\nDespués aquello.');
  });
});

describe('editing a finding body', () => {
  const body = '## T\n\n### Propuesta\n\nVieja propuesta\n\n**Después**: viejo\n\n<img src="old" alt="viejo" width="720">\n\n<details><summary>Cambio borrador usado para el después</summary>\n\n</details>\n';

  it('swaps the after image, or adds one after the proposal', () => {
    const swapped = replaceAfterImage(body, { url: 'new', nota: 'nuevo' }, 'mobile');
    expect(swapped).toContain('**Después**: nuevo\n\n<img src="new" alt="nuevo" width="320">');
    expect(swapped).not.toContain('old');
    expect(swapped).toContain('<details>');
    const added = replaceAfterImage('## T\n\n### Propuesta\n\nAlgo\n', { url: 'new' }, 'desktop');
    expect(added).toBe('## T\n\n### Propuesta\n\nAlgo\n\n**Después**\n\n<img src="new" alt="captura" width="720">\n');
  });

  it('replaces only the proposal text', () => {
    const edited = replaceProposal(body, 'Nueva propuesta');
    expect(edited).toContain('### Propuesta\n\nNueva propuesta\n\n**Después**: viejo');
    expect(edited).not.toContain('Vieja propuesta');
  });

  it('reads the redo result, keeping its path inside the output dir', () => {
    expect(parseRedoResult('{"imagen":"desktop/despues.png","nota":"alineado"}', out)).toEqual({ imagen: `${out}/desktop/despues.png`, nota: 'alineado' });
    expect(() => parseRedoResult('{"imagen":"../../x.png"}', out)).toThrow(/después/);
  });
});

describe('parseVerdicts entorno', () => {
  it('carries the dev-environment mark', () => {
    expect(parseVerdicts('{"veredictos":[{"index":0,"veredicto":"mantener","motivo":"ok","entorno":true}]}', 1)[0]).toMatchObject({ entorno: true });
  });
});

describe('clip', () => {
  it('leaves text within the limit alone', () => {
    expect(clip('  corto  ', 10)).toBe('corto');
  });

  it('cuts at a word, never mid-word, and drops the trailing punctuation', () => {
    expect(clip('el monto y la referencia quedan fuera', 20)).toBe('el monto y la…');
    expect(clip('uno, dos: tres cuatro cinco', 12)).toBe('uno, dos…');
  });

  it('cuts mid-word only when there is no space to cut at', () => {
    expect(clip('supercalifragilisticoespialidoso', 10)).toBe('supercali…');
  });
});
