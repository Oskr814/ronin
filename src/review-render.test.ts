import { describe, it, expect } from 'vitest';
import type { ReviewFinding } from './review-output.js';
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
} from './review-render.js';

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
    expect(lines[2]).toBe('<sub>Decisión · Crítico · Concurrencia / lógica</sub>');
  });

  it('shows the scenario as numbered steps with its outcome, and the evidence links, without expanding anything', () => {
    const body = renderFindingComment(finding(), ctx);
    const visible = body.split('<details>')[0];
    expect(visible).toContain('**Cómo pasa:**\n\n1. A confirma el pedido.\n2. B agrega 50×100\n\n→ B inserta 5000 sin validar. Se esperaba: que B falle.');
    expect(visible).toContain(
      '**Dónde:** [`apps/api/Services/OrderService.cs:1299`](https://github.com/redmotos/shoppingcart/blob/abcdef1234567890/apps/api/Services/OrderService.cs#L1299) solo valida en DRAFT',
    );
    expect(visible).not.toContain('**Impacto:**');
    expect(visible).not.toContain('**Verificación:**');
  });

  it('renders a one-sentence scenario inline', () => {
    const body = renderFindingComment(finding({ scenario: { steps: [], result: 'Dado A, pasa C.' } }), ctx);
    expect(body).toContain('**Cómo pasa:** Dado A, pasa C.\n');
  });

  it('shows the impact instead when there is no scenario', () => {
    expect(renderFindingComment(finding({ type: 'improvement', scenario: undefined }), ctx)).toContain('**Impacto:** Reabre el agujero de crédito.');
  });

  it('says first whether the PR brought the problem in', () => {
    const body = renderFindingComment(finding({ origin: { kind: 'worsened', note: 'la carrera ya existía, pero ahora es la única validación' } }), ctx);
    const visible = body.split('\n').slice(4).join('\n');
    expect(visible.startsWith('**Lo empeora este PR:** la carrera ya existía, pero ahora es la única validación.\n')).toBe(true);
    expect(renderFindingComment(finding({ origin: { kind: 'new' } }), ctx)).toContain('**Lo introduce este PR.**\n');
  });

  it('keeps a reasoned verification inside the detail, without a doubled period', () => {
    const body = renderFindingComment(finding({ detail: 'Más.', verification: { status: 'reasoned', reason: 'Leí UpdateQty en el head del PR.' } }), ctx);
    expect(body).toContain('<summary>Detalle</summary>\n\nMás.\n\n**Verificación:** razonado, no ejecutado — Leí UpdateQty en el head del PR.\n');
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
    expect(body.split('<details>')[0].split('OrderService.cs:1299`]').length - 1).toBe(1);
  });

  it('collapses the detail', () => {
    expect(renderFindingComment(finding({ detail: 'Más contexto.' }), ctx)).toContain('<summary>Detalle</summary>\n\nMás contexto.');
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

  it('lists every finding in a table, escaping pipes', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [] }, ctx);
    expect(body).toContain('1 hallazgo · commit `abcdef1` · criterio `a6bbe98`');
    expect(body).toContain('| 🐞 Defecto | 🟠 Importante | Inline \\| con barra (');
  });

  it('orders the table by severity', () => {
    const body = renderReviewSummary({ inline: [finding({ title: 'Menor', severity: 'minor' })], outOfDiff: [finding({ title: 'Grave', severity: 'critical' })] }, ctx);
    expect(body.indexOf('Grave')).toBeLessThan(body.indexOf('Menor'));
  });

  it('renders out-of-diff findings in full inside the summary', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [outFinding] }, ctx);
    expect(body).toContain('### Fuera del diff');
    expect(body).toContain('### 💡🟡 Afuera');
  });

  it('includes one combined prompt covering every finding', () => {
    const body = renderReviewSummary({ inline: [inlineFinding], outOfDiff: [outFinding] }, ctx);
    expect(body).toContain('Prompt para atender todos los hallazgos');
    expect(body).toContain('## 1. Inline | con barra');
    expect(body).toContain('## 2. Afuera');
  });

  it('drops the combined prompt first when the body would be too long', () => {
    const many = Array.from({ length: 40 }, (_, i) => finding({ title: `H${i}`, affectedCode: 'x'.repeat(1200), detail: 'd'.repeat(1500) }));
    const body = renderReviewSummary({ inline: many.slice(0, 20), outOfDiff: many.slice(20) }, ctx);
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
