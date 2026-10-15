import { describe, it, expect } from 'vitest';
import { parseReviewOutput, LIMITS } from './output.js';

const ctx = { mentionIds: new Set([111]), openThreadIds: new Set(['T1']) };

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: 'src/a.ts',
    line: 10,
    type: 'bug',
    severity: 'important',
    category: 'Concurrencia',
    title: 'Carrera en X',
    scenario: { steps: ['A confirma', 'B agrega'], result: 'pasa C', expected: 'D' },
    impact: 'Se pierde el pedido.',
    evidence: [{ path: 'src/a.ts', line: 10, note: 'acá' }],
    verification: { status: 'reasoned' },
    affectedCode: 'doThing();',
    ...overrides,
  };
}

function parse(output: unknown) {
  return parseReviewOutput(JSON.stringify(output), ctx);
}

describe('parseReviewOutput — top level', () => {
  it('throws on text that is not JSON — a task-level failure, retried next tick', () => {
    expect(() => parseReviewOutput('not json', ctx)).toThrow();
  });

  it('throws when the JSON is not an object', () => {
    expect(() => parse([1, 2])).toThrow();
  });

  it('treats missing arrays as empty', () => {
    const { output, dropped } = parse({});
    expect(output).toEqual({ findings: [], resolveThreads: [], mentionReplies: [] });
    expect(dropped).toEqual([]);
  });

  it('keeps a valid finding as-is', () => {
    const { output } = parse({ findings: [finding()] });
    expect(output.findings).toEqual([finding()]);
  });
});

describe('parseReviewOutput — findings', () => {
  it('drops a finding with an unknown type or severity but keeps the others', () => {
    const { output, dropped } = parse({ findings: [finding({ type: 'nitpick' }), finding({ severity: 'huge' }), finding({ title: 'ok' })] });
    expect(output.findings.map((f) => f.title)).toEqual(['ok']);
    expect(dropped.map((d) => d.index)).toEqual([0, 1]);
  });

  it('requires a scenario on bug and decision, not on improvement', () => {
    const { output } = parse({
      findings: [
        finding({ type: 'bug', scenario: '' }),
        finding({ type: 'decision', scenario: undefined }),
        finding({ type: 'improvement', scenario: undefined, title: 'mejora' }),
      ],
    });
    expect(output.findings.map((f) => f.title)).toEqual(['mejora']);
  });

  it('drops invalid line anchors', () => {
    const { output } = parse({
      findings: [finding({ line: 0 }), finding({ line: 2.5 }), finding({ line: 5, startLine: 7 }), finding({ line: '3' })],
    });
    expect(output.findings).toEqual([]);
  });

  it('drops a finding with an empty or absolute path', () => {
    const { output } = parse({ findings: [finding({ path: '' }), finding({ path: '/etc/passwd' }), finding({ path: '../x.ts' })] });
    expect(output.findings).toEqual([]);
  });

  it('truncates over-long fields with an ellipsis', () => {
    const { output } = parse({ findings: [finding({ title: 'x'.repeat(500) })] });
    expect(output.findings[0].title).toHaveLength(LIMITS.title);
    expect(output.findings[0].title.endsWith('…')).toBe(true);
  });

  it('cuts an over-long title at a word boundary, and keeps one slightly over 90 whole', () => {
    const slightlyLong = '¿`docker:dev` y `db:setup:dev` deben respetar el slot del worktree en vez de ir por su cuenta?';
    const { output } = parse({ findings: [finding({ title: slightlyLong }), finding({ title: 'palabra '.repeat(40) })] });
    expect(output.findings[0].title).toBe(slightlyLong);
    expect(output.findings[1].title).toMatch(/ palabra…$/);
    expect(output.findings[1].title.length).toBeLessThanOrEqual(LIMITS.title);
  });

  it('degrades a replace suggestion spanning more than 10 lines to a snippet', () => {
    const { output } = parse({ findings: [finding({ startLine: 1, line: 20, suggestion: { kind: 'replace', code: 'a();' } })] });
    expect(output.findings[0].suggestion).toEqual({ kind: 'snippet', code: 'a();' });
  });

  it('keeps the fix sentence, and reads it from a legacy text suggestion', () => {
    const { output } = parse({
      findings: [finding({ fix: 'Tomar el lock.' }), finding({ suggestion: { kind: 'text', text: 'Reintentar.' } })],
    });
    expect(output.findings.map((f) => f.fix)).toEqual(['Tomar el lock.', 'Reintentar.']);
    expect(output.findings[1].suggestion).toBeUndefined();
  });

  it('parses the scenario steps, capped, and accepts a one-sentence scenario as the result', () => {
    const { output } = parse({
      findings: [
        finding({ scenario: { steps: ['1', '', 2, '3', '4', '5', '6', '7'], result: 'r', expected: 'e' } }),
        finding({ scenario: 'Dado A, cuando B, pasa C.' }),
      ],
    });
    expect(output.findings[0].scenario).toEqual({ steps: ['1', '3', '4', '5', '6'], result: 'r', expected: 'e' });
    expect(output.findings[1].scenario).toEqual({ steps: [], result: 'Dado A, cuando B, pasa C.' });
  });

  it('drops a bug whose scenario has no result', () => {
    const { output } = parse({ findings: [finding({ scenario: { steps: ['a'] } })] });
    expect(output.findings).toEqual([]);
  });

  it('keeps the origin and publishes a preexisting problem as minor whatever the agent proposed', () => {
    const { output } = parse({
      findings: [
        finding({ severity: 'critical', origin: { kind: 'worsened', note: 'quitó la otra validación' } }),
        finding({ severity: 'critical', origin: { kind: 'preexisting' } }),
        finding({ origin: { kind: 'maybe' } }),
      ],
    });
    expect(output.findings.map((f) => [f.severity, f.origin])).toEqual([
      ['critical', { kind: 'worsened', note: 'quitó la otra validación' }],
      ['minor', { kind: 'preexisting' }],
      ['important', undefined],
    ]);
  });

  it('keeps a replace suggestion within 10 lines', () => {
    const { output } = parse({ findings: [finding({ startLine: 5, line: 10, suggestion: { kind: 'replace', code: 'a();' } })] });
    expect(output.findings[0].suggestion).toEqual({ kind: 'replace', code: 'a();' });
  });

  it('drops malformed evidence and extra locations entries without dropping the finding', () => {
    const { output } = parse({
      findings: [finding({ evidence: [{ path: 'b.ts', line: 'x', note: 'n' }, { path: 'c.ts', line: 3, note: 'ok' }], extraLocations: [{ path: 'd.ts' }] })],
    });
    expect(output.findings[0].evidence).toEqual([{ path: 'c.ts', line: 3, note: 'ok' }]);
    expect(output.findings[0].extraLocations).toEqual([]);
  });

  it('defaults an unknown verification status to reasoned', () => {
    const { output } = parse({ findings: [finding({ verification: { status: 'sure' } })] });
    expect(output.findings[0].verification).toEqual({ status: 'reasoned' });
  });

  it('drops a mentionId that does not belong to this run', () => {
    const { output } = parse({ findings: [finding({ mentionId: 999 }), finding({ mentionId: 111, title: 'pedido' })] });
    expect(output.findings.map((f) => f.mentionId)).toEqual([undefined, 111]);
  });
});

describe('parseReviewOutput — threads and mention replies', () => {
  it('only resolves the bot\'s own open threads', () => {
    const { output, dropped } = parse({ resolveThreads: [{ threadId: 'T1', reason: 'arreglado' }, { threadId: 'T9', reason: 'x' }] });
    expect(output.resolveThreads).toEqual([{ threadId: 'T1', reason: 'arreglado' }]);
    expect(dropped).toHaveLength(1);
  });

  it('only replies to mentions from this run, with a valid kind', () => {
    const { output } = parse({
      mentionReplies: [
        { commentId: 111, kind: 'issue', body: 'hecho' },
        { commentId: 222, kind: 'issue', body: 'x' },
        { commentId: 111, kind: 'weird', body: 'x' },
      ],
    });
    expect(output.mentionReplies).toEqual([{ commentId: 111, kind: 'issue', body: 'hecho' }]);
  });
});

describe('parseReviewOutput — verification', () => {
  const test = { path: 'tests/X.cs', code: 'Assert.True(false);', output: 'FAILED' };

  it('keeps a verified finding with its test when execution was allowed', () => {
    const { output } = parseReviewOutput(JSON.stringify({ findings: [finding({ verification: { status: 'verified', test } })] }), { ...ctx, allowVerified: true });
    expect(output.findings[0].verification).toEqual({ status: 'verified', test });
  });

  it('downgrades it to reasoned on a run that could not execute anything (a fork)', () => {
    const { output } = parseReviewOutput(JSON.stringify({ findings: [finding({ verification: { status: 'verified', test } })] }), { ...ctx, allowVerified: false });
    expect(output.findings[0].verification).toEqual({ status: 'reasoned' });
  });

  it('downgrades a verified claim without the test attached, even when execution was allowed', () => {
    const { output } = parseReviewOutput(JSON.stringify({ findings: [finding({ verification: { status: 'verified' } })] }), { ...ctx, allowVerified: true });
    expect(output.findings[0].verification).toEqual({ status: 'reasoned' });
  });
});
