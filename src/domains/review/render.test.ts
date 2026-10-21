import { describe, it, expect } from 'vitest';
import type { ReviewFinding } from './output.js';
import {
  neutralizeMentions,
  findingMarker,
  renderFindingComment,
  renderAgentPrompt,
  renderCombinedAgentPrompt,
  renderReviewSummary,
  renderClosing,
  SUMMARY_MAX,
  type RenderContext,
} from './render.js';

const ctx: RenderContext = { repo: 'redmotos/shoppingcart', headSha: 'abcdef1234567890', criteriaHash: 'a6bbe981a8748cb8', mode: 'full' };

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'apps/api/Services/OrderService.cs',
    line: 1299,
    type: 'bug',
    severity: 'important',
    category: 'Concurrencia / lógica',
    title: 'Agregar líneas omite el crédito',
    scenario: { steps: ['A confirma el pedido.', 'B agrega 50×100'], result: 'B inserta 5000 sin validar', expected: 'que B falle' },
    impact: 'Reabre el agujero de crédito.',
    evidence: [{ path: 'apps/api/Services/OrderService.cs', line: 1299, note: 'solo valida en DRAFT' }],
    verification: { status: 'reasoned' },
    affectedCode: 'if (state == DRAFT) Validate();',
    ...overrides,
  };
}

describe('neutralizeMentions', () => {
  it('breaks user and team mentions without changing how they read', () => {
    expect(neutralizeMentions('ping @someone and @org/team')).toBe('ping @‍someone and @‍org/team');
  });

  it('leaves email addresses alone', () => {
    expect(neutralizeMentions('write to a@b.com')).toBe('write to a@b.com');
  });

  it('handles a mention at the very start', () => {
    expect(neutralizeMentions('@dev mirá')).toBe('@‍dev mirá');
  });
});

describe('findingMarker', () => {
  it('records every field, with a category that cannot break the HTML comment', () => {
    expect(findingMarker(finding({ category: 'Concurrencia --> / Lógica' }), ctx)).toBe(
      '<!-- ronin:finding v=2 type=bug severity=important category=concurrencia-logica verification=reasoned mode=full scope=changed criteria=a6bbe981a8748cb8 -->',
    );
  });

  it('takes the scope from the context when provided', () => {
    expect(findingMarker(finding(), { ...ctx, mode: 'incremental', scopeOf: () => 'reviewed' })).toContain('mode=incremental scope=reviewed');
  });
});

describe('renderFindingComment', () => {
  it('starts with the marker and derives both emojis from the fields', () => {
    const body = renderFindingComment(finding({ type: 'decision', severity: 'critical' }), ctx);
    const lines = body.split('\n');
    expect(lines[0]).toMatch(/^<!-- ronin:finding /);
    expect(lines[1]).toBe('### 🔴 Agregar líneas omite el crédito');
  });

  // Only what to look at shows; the rest waits in one collapsed «Detalle».
  it('shows only the title and the plain explanation, everything else collapsed', () => {
    const body = renderFindingComment(finding({ fix: 'Reintentar.', suggestion: { kind: 'replace', code: 'throw new Retry();' } }), ctx);
    const [visible, ...rest] = body.split('<details>');
    expect(visible.split('\n').slice(1).join('\n').trim()).toBe('### 🐞🟠 Agregar líneas omite el crédito\n\nReabre el agujero de crédito.');
    expect(body.match(/<details>/g)!.length).toBe(2);
    expect(rest[0]).toMatch(/^\n<summary>Detalle<\/summary>\n\nDefecto · Importante · Concurrencia \/ lógica\n/);
  });

  it('keeps how it happens, where, the fix and the verification inside the detail', () => {
    const body = renderFindingComment(finding({ fix: 'Reintentar.', suggestion: { kind: 'replace', code: 'throw new Retry();' } }), ctx);
    const detail = body.split('<summary>Detalle</summary>')[1];
    expect(detail).toContain('**Cómo pasa:**\n\n1. A confirma el pedido.\n2. B agrega 50×100\n\n→ B inserta 5000 sin validar. Se esperaba: que B falle.');
    expect(detail).toContain(
      '**Dónde:** [`apps/api/Services/OrderService.cs:1299`](https://github.com/redmotos/shoppingcart/blob/abcdef1234567890/apps/api/Services/OrderService.cs#L1299)',
    );
    expect(detail).toContain('**Corrección:** Reintentar.\n```suggestion');
    expect(detail).toContain('**Verificación:** razonado, no ejecutado.');
  });

  it('renders a one-sentence scenario inline', () => {
    const body = renderFindingComment(finding({ scenario: { steps: [], result: 'Dado A, pasa C.' } }), ctx);
    expect(body).toContain('**Cómo pasa:** Dado A, pasa C.\n');
  });

  it('keeps where the problem came from inside the detail', () => {
    const body = renderFindingComment(finding({ origin: { kind: 'worsened', note: 'la carrera ya existía, pero ahora es la única validación' } }), ctx);
    expect(body.split('<details>')[0]).not.toContain('Lo empeora');
    expect(body.split('<summary>Detalle</summary>')[1]).toContain('**Lo empeora este PR:** la carrera ya existía, pero ahora es la única validación.');
  });

  it('keeps a reasoned verification inside the detail, without a doubled period', () => {
    const body = renderFindingComment(finding({ detail: 'Más.', verification: { status: 'reasoned', reason: 'Leí UpdateQty en el head del PR.' } }), ctx);
    expect(body).toContain('**Verificación:** razonado, no ejecutado — Leí UpdateQty en el head del PR.\n\nMás.');
  });

  it('tells the reader how to dismiss a decision', () => {
    expect(renderFindingComment(finding({ type: 'decision' }), ctx)).toContain('**Si es intencional:** resolvé el hilo.');
    expect(renderFindingComment(finding({ type: 'bug' }), ctx)).not.toContain('Si es intencional');
  });

  it('puts the fix sentence right above a one-click suggestion block', () => {
    const body = renderFindingComment(finding({ fix: 'Reintentar.', suggestion: { kind: 'replace', code: 'throw new Retry();' } }), ctx);
    expect(body).toContain('**Corrección:** Reintentar.\n```suggestion\nthrow new Retry();\n```');
  });

  it('uses a longer fence when the suggested code contains backticks', () => {
    const body = renderFindingComment(finding({ suggestion: { kind: 'replace', code: 'const s = `a ```b````;' } }), ctx);
    expect(body).toContain('`````suggestion\n');
  });

  it('renders a snippet as plain code in the file language', () => {
    expect(renderFindingComment(finding({ suggestion: { kind: 'snippet', code: 'Lock();' } }), ctx)).toContain('```csharp\nLock();\n```');
  });

  it('lists the other locations once, skipping the anchor and the evidence', () => {
    const body = renderFindingComment(
      finding({
        extraLocations: [
          { path: 'a.cs', line: 3 },
          { path: 'apps/api/Services/OrderService.cs', line: 1299 },
          { path: 'b.cs', line: 9 },
        ],
      }),
      ctx,
    );
    expect(body).toMatch(/solo valida en DRAFT · también \[`a\.cs:3`\]\([^)]+\), \[`b\.cs:9`\]/);
    expect(body.split('OrderService.cs:1299`]').length - 1).toBe(1);
  });

  it('collapses the model\'s own detail too', () => {
    const body = renderFindingComment(finding({ detail: 'Más contexto.' }), ctx);
    expect(body.split('<details>')[0]).not.toContain('Más contexto.');
    expect(body).toContain('Más contexto.');
  });

  it('attaches the failing test when verified', () => {
    const body = renderFindingComment(
      finding({ verification: { status: 'verified', test: { path: 'tests/X.cs', code: 'Assert.True(false);', output: 'FAILED' } } }),
      ctx,
    );
    expect(body).toContain('**Verificación:** ✅ comprobado con un test que falla');
    expect(body).toContain('Assert.True(false);');
    expect(body).toContain('FAILED');
  });

  it('ends with the collapsed agent prompt', () => {
    const body = renderFindingComment(finding(), ctx);
    expect(body.trimEnd().endsWith('</details>')).toBe(true);
    expect(body).toContain('<summary>Prompt para agentes de IA 🤖</summary>');
  });

  it('neutralizes mentions in every model-written field', () => {
    const body = renderFindingComment(
      finding({ title: 'ver @a', scenario: { steps: ['según @b'], result: '@c' }, detail: '@d', fix: '@e' }),
      ctx,
    );
    expect(body).not.toMatch(/@[a-e]\b/);
  });
});

describe('renderAgentPrompt', () => {
  it('is a self-contained, copyable block that asks to verify before changing', () => {
    const prompt = renderAgentPrompt(finding({ fix: 'Reintentar.', suggestion: { kind: 'replace', code: 'throw new Retry();' }, origin: { kind: 'new' } }));
    expect(prompt.startsWith('````markdown\n')).toBe(true);
    expect(prompt.endsWith('\n````')).toBe(true);
    expect(prompt).toContain('`apps/api/Services/OrderService.cs` (línea 1299)');
    expect(prompt).toContain('Origen: Lo introduce este PR.');
    expect(prompt).toContain('Escenario:\n1. A confirma el pedido.\n2. B agrega 50×100\nResultado: B inserta 5000 sin validar. Se esperaba: que B falle.');
    expect(prompt).toContain('```csharp\nif (state == DRAFT) Validate();\n```');
    expect(prompt).toContain('Corrección propuesta: Reintentar.\n\nCódigo:\n```csharp\nthrow new Retry();\n```');
    expect(prompt).toContain('Antes de cambiar: confirmá que el escenario es posible');
  });

  it('asks before changing anything on a decision', () => {
    expect(renderAgentPrompt(finding({ type: 'decision' }))).toContain('preguntá antes de cambiar');
  });
});

describe('renderReviewSummary', () => {
  const inlineFinding = finding({ title: 'Inline | con barra' });
  const outFinding = finding({ title: 'Afuera', path: 'docs/x.md', line: 4, type: 'improvement', severity: 'minor', scenario: undefined });

  it('has no summary of its own: only a collapsed prompt when every finding is on its line', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [], minor: [] }, ctx);
    expect(body.startsWith('<details>\n<summary>Prompt para atender todos los hallazgos 🤖</summary>')).toBe(true);
    expect(renderReviewSummary({ inline: [], outOfDiff: [], minor: [] }, ctx)).toBe('');
  });

  it('lists the minor findings collapsed, one line each with its location', () => {
    const body = renderReviewSummary({ inline: [], outOfDiff: [], minor: [finding({ title: 'Nombre poco claro', type: 'improvement', severity: 'minor' }), finding({ title: '¿Es a propósito?', type: 'decision', severity: 'minor', line: 7 })] }, ctx);
    expect(body).toContain('<summary>2 observaciones menores</summary>');
    expect(body).toContain('- 💡 Nombre poco claro ([`apps/api/Services/OrderService.cs:1299`](');
    expect(body).toContain('- ¿Es a propósito? ([`apps/api/Services/OrderService.cs:7`](');
    expect(body).not.toContain('Prompt para atender');
  });

  it('renders out-of-diff findings in full inside the summary, the most severe first', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [outFinding, finding({ title: 'Grave', severity: 'critical', path: 'docs/y.md', line: 2 })], minor: [] }, ctx);
    expect(body).toContain('así que van aquí y no en la línea');
    expect(body).toContain('### 💡🟡 Afuera');
    expect(body.indexOf('Grave')).toBeLessThan(body.indexOf('Afuera'));
  });

  it('includes one combined prompt covering every finding', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [outFinding], minor: [] }, ctx);
    expect(body).toContain('Prompt para atender todos los hallazgos');
    expect(body).toContain('## 1. Inline | con barra');
    expect(body).toContain('## 2. Afuera');
  });

  it('drops the combined prompt first when the body would be too long', () => {
    const many = Array.from({ length: 40 }, (_, i) => finding({ title: `H${i}`, affectedCode: 'x'.repeat(1200), detail: 'd'.repeat(1500) }));
    const body = renderReviewSummary({ inline: many.slice(0, 20), outOfDiff: many.slice(20), minor: [] }, ctx);
    expect(body.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(body).not.toContain('Prompt para atender todos los hallazgos');
  });
});

describe('renderCombinedAgentPrompt', () => {
  it('numbers the findings inside a single fence', () => {
    const prompt = renderCombinedAgentPrompt([finding({ title: 'Uno' }), finding({ title: 'Dos' })]);
    expect(prompt).toMatch(/^````markdown\nHay 2 hallazgos/);
    expect(prompt).toContain('## 1. Uno');
    expect(prompt).toContain('## 2. Dos');
  });
});

describe('renderClosing', () => {
  it('says LGTM only when nothing is open', () => {
    expect(renderClosing('lgtm')).toBe('LGTM 🚀');
  });

  it('confirms fixes when it resolved everything', () => {
    expect(renderClosing('confirmed')).toBe('✅ Ajustes confirmados, no quedan observaciones pendientes.');
  });

  it('lists what is still open instead of claiming LGTM', () => {
    expect(renderClosing({ open: [{ url: 'https://x/1', title: 'Carrera' }, { url: 'https://x/2', title: 'Otro' }] })).toBe(
      'Sin observaciones nuevas; quedan 2 abiertas:\n\n- [Carrera](https://x/1)\n- [Otro](https://x/2)',
    );
  });
});
