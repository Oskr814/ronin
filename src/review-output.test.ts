import { describe, it, expect } from 'vitest';
import { parseReviewOutput, LIMITS } from './review-output.js';

const ctx = { mentionIds: new Set([111]), openThreadIds: new Set(['T1']) };

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: 'src/a.ts',
    line: 10,
    type: 'bug',
    severity: 'important',
    category: 'Concurrencia',
    title: 'Carrera en X',
    scenario: 'Dado A, cuando B, pasa C; se esperaba D.',
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

  it('degrades a replace suggestion spanning more than 10 lines to text', () => {
    const { output } = parse({ findings: [finding({ startLine: 1, line: 20, suggestion: { kind: 'replace', code: 'a();' } })] });
    expect(output.findings[0].suggestion).toEqual({ kind: 'text', text: '```\na();\n```' });
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
