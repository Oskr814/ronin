import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewFinding } from './output.js';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@platform/agents/repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'o/r', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/wt' }),
}));

const {
  parseCommentableLines,
  commentableLines,
  placeFindings,
  parseAddedLines,
  classifyChanged,
  changedLinesSince,
  formatChangedLines,
  isOnChangedCode,
  applyScopeRules,
  dedupeAgainstOpenThreads,
} = await import('./scope.js');

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function x() {',
  ' context10',
  '-removed',
  '+added11',
  '+added12',
  ' context13',
  ' context14',
  '@@ -40,2 +41,2 @@',
  ' context41',
  '+added42',
  '\\ No newline at end of file',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 90%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
].join('\n');

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/a.ts',
    line: 11,
    type: 'bug',
    severity: 'important',
    category: 'Bug',
    title: 't',
    scenario: { steps: [], result: 's' },
    impact: 'i',
    evidence: [],
    verification: { status: 'reasoned' },
    affectedCode: 'c',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseCommentableLines', () => {
  it('collects added and context lines on the new side, never removed ones', () => {
    const lines = parseCommentableLines(DIFF);
    expect([...lines.get('src/a.ts')!].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 41, 42]);
  });

  it('uses the new name of a renamed file', () => {
    const lines = parseCommentableLines(DIFF);
    expect(lines.get('new/name.ts')).toEqual(new Set([1]));
    expect(lines.has('old/name.ts')).toBe(false);
  });

  it('ignores deleted and binary files', () => {
    const lines = parseCommentableLines(DIFF);
    expect(lines.has('gone.ts')).toBe(false);
    expect(lines.has('img.png')).toBe(false);
  });
});

describe('commentableLines', () => {
  it('diffs the head against its merge base with the base branch, with GitHub\'s context', async () => {
    execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: null, r: { stdout: string }) => void) => {
      if (args[0] === 'merge-base') return cb(null, { stdout: 'base123\n' });
      if (args[0] === 'diff') return cb(null, { stdout: DIFF });
      return cb(null, { stdout: '' });
    });

    const lines = await commentableLines('head456', 'odoo-main');

    const calls = execFile.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([
      ['fetch', 'origin', 'odoo-main'],
      ['merge-base', 'origin/odoo-main', 'head456'],
      ['diff', '-U3', 'base123', 'head456'],
    ]);
    expect(execFile.mock.calls[0][2]).toMatchObject({ cwd: '/tmp/repo' });
    expect(lines.get('src/a.ts')?.has(42)).toBe(true);
  });
});

describe('placeFindings', () => {
  const commentable = parseCommentableLines(DIFF);

  it('anchors a finding on a commentable line inline', () => {
    expect(placeFindings([finding()], commentable)).toEqual({ inline: [finding()], outOfDiff: [] });
  });

  it('moves a finding outside the diff to the summary', () => {
    const outside = [finding({ line: 30 }), finding({ path: 'other.ts' })];
    expect(placeFindings(outside, commentable)).toEqual({ inline: [], outOfDiff: outside });
  });

  it('keeps a multi-line anchor when the whole range is commentable', () => {
    const f = finding({ startLine: 10, line: 13, suggestion: { kind: 'replace', code: 'x' } });
    expect(placeFindings([f], commentable).inline).toEqual([f]);
  });

  it('turns the suggestion of an out-of-diff finding into a snippet', () => {
    const { outOfDiff } = placeFindings([finding({ path: 'nowhere.cs', line: 1, suggestion: { kind: 'replace', code: 'x()' } })], new Map());
    expect(outOfDiff[0].suggestion).toEqual({ kind: 'snippet', code: 'x()' });
  });

  it('falls back to the last line and degrades the suggestion when the range is not fully commentable', () => {
    const f = finding({ startLine: 13, line: 41, suggestion: { kind: 'replace', code: 'x()' } });
    const [placed] = placeFindings([f], commentable).inline;
    expect(placed.startLine).toBeUndefined();
    expect(placed.line).toBe(41);
    expect(placed.suggestion).toEqual({ kind: 'snippet', code: 'x()' });
  });
});

// A -U0 diff of one file, built from its hunks: [newStart, addedLines].
function diffOf(path: string, hunks: Array<[number, string[]]>): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap(([start, added]) => [`@@ -${start},0 +${start},${added.length} @@`, ...added.map((l) => `+${l}`)]),
  ].join('\n');
}

describe('parseAddedLines', () => {
  it('keeps only the added lines, with their new-side number and content', () => {
    const diff = ['diff --git a/a.cs b/a.cs', '--- a/a.cs', '+++ b/a.cs', '@@ -5,3 +5,3 @@', ' ctx();', '-old();', '+new();', ' ctx2();', '+tail();'].join('\n');
    expect(parseAddedLines(diff).get('a.cs')).toEqual([
      { line: 6, content: 'new();' },
      { line: 8, content: 'tail();' },
    ]);
  });
});

describe('classifyChanged', () => {
  it('marks only the line an amend edited', () => {
    const prev = diffOf('src/a.cs', [[10, ['a();', 'b();', 'c();']]]);
    const head = diffOf('src/a.cs', [[10, ['a();', 'B();', 'c();']]]);
    expect(classifyChanged(prev, head)).toEqual(new Map([['src/a.cs', new Set([11])]]));
  });

  it('marks only an inserted line, not the ones it shifts down', () => {
    const prev = diffOf('src/a.cs', [[10, ['a();', 'b();']]]);
    const head = diffOf('src/a.cs', [[10, ['a();', 'nuevo();', 'b();']]]);
    expect(classifyChanged(prev, head)).toEqual(new Map([['src/a.cs', new Set([11])]]));
  });

  it('ignores indentation and blank lines', () => {
    const prev = diffOf('src/a.cs', [[10, ['  a();']]]);
    const head = diffOf('src/a.cs', [[20, ['a();', '', '   ']]]);
    expect(classifyChanged(prev, head)).toEqual(new Map());
  });

  it('sees nothing changed after a rebase that only moved the base', () => {
    // The base changes are in neither PR diff; the PR's own lines only move.
    const prev = diffOf('src/a.cs', [[10, ['a();']]]);
    const head = diffOf('src/a.cs', [[42, ['a();']]]);
    expect(classifyChanged(prev, head)).toEqual(new Map());
  });

  it('counts a file new to the PR as entirely changed', () => {
    const prev = diffOf('src/a.cs', [[10, ['a();']]]);
    const head = [prev, diffOf('src/b.cs', [[1, ['x();', 'y();']]])].join('\n');
    expect(classifyChanged(prev, head)).toEqual(new Map([['src/b.cs', new Set([1, 2])]]));
  });

  it('counts a renamed file as entirely changed (documented limitation)', () => {
    const prev = diffOf('src/old.cs', [[1, ['x();']]]);
    const head = diffOf('src/new.cs', [[1, ['x();']]]);
    expect(classifyChanged(prev, head)).toEqual(new Map([['src/new.cs', new Set([1])]]));
  });
});

describe('changedLinesSince', () => {
  it('diffs each SHA against its own merge base, without context', async () => {
    execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: null, r: { stdout: string }) => void) => {
      if (args[0] === 'merge-base') return cb(null, { stdout: `${args[2] === 'prev' ? 'mbPrev' : 'mbHead'}\n` });
      if (args[0] === 'diff') return cb(null, { stdout: args[3] === 'prev' ? diffOf('a.cs', [[1, ['x();']]]) : diffOf('a.cs', [[1, ['x();', 'y();']]]) });
      return cb(null, { stdout: '' });
    });

    const changed = await changedLinesSince('prev', 'head', 'main');

    const calls = execFile.mock.calls.map((c) => c[1]);
    expect(calls).toContainEqual(['diff', '-U0', 'mbPrev', 'prev']);
    expect(calls).toContainEqual(['diff', '-U0', 'mbHead', 'head']);
    expect(changed).toEqual(new Map([['a.cs', new Set([2])]]));
  });
});

describe('formatChangedLines', () => {
  it('collapses consecutive lines into ranges, one file per row', () => {
    expect(formatChangedLines(new Map([['b.cs', new Set([30, 10, 11, 12, 14])], ['a.cs', new Set([1])]]))).toBe('a.cs: 1\nb.cs: 10-12, 14, 30');
  });
});

describe('isOnChangedCode', () => {
  const changed = new Map([['src/a.ts', new Set([12])], ['src/b.ts', new Set([3])]]);

  it('looks at every line of the anchored range', () => {
    expect(isOnChangedCode(finding({ startLine: 10, line: 13 }), changed)).toBe(true);
    expect(isOnChangedCode(finding({ line: 11 }), changed)).toBe(false);
  });

  it('counts a systemic finding whose other instance changed', () => {
    expect(isOnChangedCode(finding({ line: 11, extraLocations: [{ path: 'src/b.ts', line: 3 }] }), changed)).toBe(true);
  });
});

describe('applyScopeRules', () => {
  const changed = new Map([['src/a.ts', new Set([11])]]);
  const reviewed = { path: 'src/old.ts', line: 5 };
  const evidence = [{ path: 'src/old.ts', line: 5, note: 'n' }];

  it('keeps everything in full mode', () => {
    const findings = [finding({ ...reviewed, severity: 'minor' })];
    expect(applyScopeRules(findings, { mode: 'full' }).kept).toEqual(findings);
  });

  it('keeps anything on changed code', () => {
    const f = finding({ type: 'improvement', severity: 'minor' });
    expect(applyScopeRules([f], { mode: 'incremental', changed }).kept).toEqual([f]);
  });

  it('drops minor findings and improvements on reviewed code', () => {
    const { kept, dropped } = applyScopeRules(
      [finding({ ...reviewed, severity: 'minor', evidence }), finding({ ...reviewed, type: 'improvement', severity: 'important', evidence })],
      { mode: 'incremental', changed },
    );
    expect(kept).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual(['menor o mejora sobre código ya revisado', 'menor o mejora sobre código ya revisado']);
  });

  it('keeps an important bug on reviewed code only with evidence', () => {
    const withEvidence = finding({ ...reviewed, evidence });
    const without = finding({ ...reviewed, title: 'sin' });
    const { kept, dropped } = applyScopeRules([withEvidence, without], { mode: 'incremental', changed });
    expect(kept).toEqual([withEvidence]);
    expect(dropped[0].reason).toBe('sobre código ya revisado sin evidencia');
  });

  it('never drops what a mention asked for', () => {
    const f = finding({ ...reviewed, severity: 'minor', mentionId: 7 });
    expect(applyScopeRules([f], { mode: 'incremental', changed }).kept).toEqual([f]);
  });
});

describe('dedupeAgainstOpenThreads', () => {
  const thread = (overrides: Record<string, unknown> = {}) => ({
    id: 'T1',
    body: '<!-- ronin:finding v=2 type=bug severity=important category=concurrencia verification=reasoned -->\n### x',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 14,
    originalLine: 14,
    replies: [],
    thumbsUp: 0,
    thumbsDown: 0,
    ...overrides,
  });

  it('drops a finding repeating an open thread: same file, category and within 5 lines', () => {
    const { kept, dropped } = dedupeAgainstOpenThreads([finding({ category: 'Concurrencia', line: 11 })], [thread()]);
    expect(kept).toEqual([]);
    expect(dropped[0].threadId).toBe('T1');
  });

  it('keeps it when the category, the file or the distance differ', () => {
    const findings = [
      finding({ category: 'Seguridad', line: 11 }),
      finding({ category: 'Concurrencia', path: 'src/b.ts', line: 14 }),
      finding({ category: 'Concurrencia', line: 30 }),
    ];
    expect(dedupeAgainstOpenThreads(findings, [thread()]).kept).toEqual(findings);
  });

  it('never matches resolved, outdated or unmarked threads', () => {
    const f = finding({ category: 'Concurrencia', line: 14 });
    for (const t of [thread({ isResolved: true }), thread({ line: null, isOutdated: true }), thread({ body: '### viejo formato' })]) {
      expect(dedupeAgainstOpenThreads([f], [t]).kept).toEqual([f]);
    }
  });

  it('keeps what a mention asked for', () => {
    const f = finding({ category: 'Concurrencia', line: 14, mentionId: 3 });
    expect(dedupeAgainstOpenThreads([f], [thread()]).kept).toEqual([f]);
  });
});
