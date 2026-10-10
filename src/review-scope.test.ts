import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewFinding } from './review-output.js';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'o/r', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/wt' }),
}));

const { parseCommentableLines, commentableLines, placeFindings } = await import('./review-scope.js');

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
