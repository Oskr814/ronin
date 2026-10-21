import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeRepo } from '../../core/repo-context.js';
import type { ReviewFinding } from './output.js';
import type { BotThread } from '../../core/github.js';
import { slug } from './render.js';

const execFileAsync = promisify(execFile);

// Which lines of the PR a review comment can be anchored to, and where each
// finding ends up (inline vs. the review summary). Stage 2 of
// docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md adds
// the content-based changed/reviewed classification to this same module.

export type CommentableLines = Map<string, Set<number>>;

// GitHub only accepts inline comments on lines inside a diff hunk on the
// side being commented (RIGHT = the PR head): added lines and the context
// lines around them. Removed lines don't exist on that side.
export function parseCommentableLines(unifiedDiff: string): CommentableLines {
  const result: CommentableLines = new Map();
  let current: Set<number> | undefined;
  let nextLine = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      if (target === '/dev/null') {
        current = undefined;
      } else {
        const path = target.startsWith('b/') ? target.slice(2) : target;
        current = result.get(path) ?? new Set();
        result.set(path, current);
      }
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!current || nextLine === 0) continue;
    if (line.startsWith('+') || line.startsWith(' ')) {
      current.add(nextLine);
      nextLine += 1;
    }
    // '-' lines and "\ No newline at end of file" don't advance the new side.
  }
  // A file with no commentable line (pure deletion, binary) is not anchorable.
  for (const [path, lines] of result) if (lines.size === 0) result.delete(path);
  return result;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: activeRepo().productRepoPath, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// The PR's diff against its own merge base, with the same 3 lines of context
// GitHub renders — anything outside those hunks can't take an inline
// comment. ensureExternalReviewWorktree has already fetched the PR head; the
// base branch is fetched here so the merge base is current.
export async function commentableLines(headSha: string, baseRefName: string): Promise<CommentableLines> {
  await git(['fetch', 'origin', baseRefName]);
  const mergeBase = (await git(['merge-base', `origin/${baseRefName}`, headSha])).trim();
  return parseCommentableLines(await git(['diff', '-U3', mergeBase, headSha]));
}

const DIFF_STAT_MAX_LINES = 300;

// What the review orchestrator needs to start working without rediscovering
// it: the merge base and the diff's file list. Fetches the PR head and the
// base first, so every later git call on headSha (changedLinesSince,
// commentableLines) finds both.
export async function diffContext(prNumber: number, headSha: string, baseRefName: string): Promise<{ mergeBase: string; stat: string }> {
  await git(['fetch', 'origin', baseRefName, `pull/${prNumber}/head`]);
  const mergeBase = (await git(['merge-base', `origin/${baseRefName}`, headSha])).trim();
  const lines = (await git(['diff', '--stat=200', mergeBase, headSha])).trimEnd().split('\n');
  const stat = lines.length > DIFF_STAT_MAX_LINES
    ? [...lines.slice(0, DIFF_STAT_MAX_LINES), `… (${lines.length - DIFF_STAT_MAX_LINES} líneas más: "git diff --stat ${mergeBase} HEAD")`].join('\n')
    : lines.join('\n');
  return { mergeBase, stat };
}

// A multi-line anchor is only valid when every line in the range is
// commentable; otherwise the comment falls back to its last line alone. A
// suggestion block replaces exactly the anchored range, so a "replace"
// suggestion written for the full range can't survive that fallback and is
// shown as plain code instead.
export function placeFindings(
  findings: ReviewFinding[],
  commentable: CommentableLines,
): { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] } {
  const inline: ReviewFinding[] = [];
  const outOfDiff: ReviewFinding[] = [];
  for (const finding of findings) {
    const lines = commentable.get(finding.path);
    if (!lines?.has(finding.line)) {
      // Out of the diff it goes in the review body, where a suggestion
      // block can't be applied.
      outOfDiff.push(finding.suggestion?.kind === 'replace' ? { ...finding, suggestion: { kind: 'snippet', code: finding.suggestion.code } } : finding);
      continue;
    }
    if (finding.startLine == null) {
      inline.push(finding);
      continue;
    }
    let wholeRange = true;
    for (let l = finding.startLine; l <= finding.line; l += 1) {
      if (!lines.has(l)) {
        wholeRange = false;
        break;
      }
    }
    if (wholeRange) {
      inline.push(finding);
      continue;
    }
    const { startLine: _dropped, ...single } = finding;
    if (single.suggestion?.kind === 'replace') single.suggestion = { kind: 'snippet', code: single.suggestion.code };
    inline.push(single);
  }
  return { inline, outOfDiff };
}

// --- Incremental scope (stage 2) ---------------------------------------
//
// Which lines changed since the last review is decided by content, not by
// history: the PR is amended into a single commit, rebased and sometimes
// merges its base, so "commits since X" means nothing. Each SHA is diffed
// against its own merge base with the base branch, and a line the head adds
// counts as changed when the previous diff did not add the same content in
// the same file. Known limits, both conservative or harmless: a line moved
// unchanged counts as reviewed; a renamed file counts as entirely changed.

export type ChangedLines = Map<string, Set<number>>;

export function parseAddedLines(unifiedDiff: string): Map<string, Array<{ line: number; content: string }>> {
  const result = new Map<string, Array<{ line: number; content: string }>>();
  let current: Array<{ line: number; content: string }> | undefined;
  let nextLine = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      if (target === '/dev/null') {
        current = undefined;
      } else {
        const path = target.startsWith('b/') ? target.slice(2) : target;
        current = result.get(path) ?? [];
        result.set(path, current);
      }
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (!current || nextLine === 0) continue;
    if (line.startsWith('+')) {
      current.push({ line: nextLine, content: line.slice(1) });
      nextLine += 1;
    } else if (line.startsWith(' ')) {
      nextLine += 1;
    }
  }
  return result;
}

function normalize(content: string): string {
  return content.trim();
}

export function classifyChanged(prevDiff: string, headDiff: string): ChangedLines {
  const previous = parseAddedLines(prevDiff);
  const changed: ChangedLines = new Map();
  for (const [path, added] of parseAddedLines(headDiff)) {
    const seen = new Set((previous.get(path) ?? []).map((a) => normalize(a.content)));
    const lines = new Set<number>();
    for (const a of added) {
      const content = normalize(a.content);
      if (content !== '' && !seen.has(content)) lines.add(a.line);
    }
    if (lines.size > 0) changed.set(path, lines);
  }
  return changed;
}

async function diffAgainstMergeBase(sha: string, baseRefName: string): Promise<string> {
  const mergeBase = (await git(['merge-base', `origin/${baseRefName}`, sha])).trim();
  return git(['diff', '-U0', mergeBase, sha]);
}

export async function changedLinesSince(prevSha: string, headSha: string, baseRefName: string): Promise<ChangedLines> {
  await git(['fetch', 'origin', baseRefName]);
  const [prevDiff, headDiff] = await Promise.all([diffAgainstMergeBase(prevSha, baseRefName), diffAgainstMergeBase(headSha, baseRefName)]);
  return classifyChanged(prevDiff, headDiff);
}

// "path: 10-14, 30" per file, for the incremental prompt.
export function formatChangedLines(changed: ChangedLines): string {
  const rows: string[] = [];
  for (const [path, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...lines].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (const l of [...sorted.slice(1), Number.NaN]) {
      if (l === prev + 1) {
        prev = l;
        continue;
      }
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = l;
      prev = l;
    }
    rows.push(`${path}: ${ranges.join(', ')}`);
  }
  return rows.join('\n');
}

export function isOnChangedCode(finding: ReviewFinding, changed: ChangedLines): boolean {
  const has = (path: string, line: number) => changed.get(path)?.has(line) ?? false;
  for (let l = finding.startLine ?? finding.line; l <= finding.line; l += 1) if (has(finding.path, l)) return true;
  return (finding.extraLocations ?? []).some((l) => has(l.path, l.line));
}

export type ReviewMode = { mode: 'full' } | { mode: 'incremental'; changed: ChangedLines };

// On code an earlier round already reviewed, only what that round should
// not have missed is still worth a comment: minor findings and improvements
// there are noise that keeps the review from converging. A finding a human
// explicitly asked for in a mention is always kept.
export function applyScopeRules(
  findings: ReviewFinding[],
  scope: ReviewMode,
): { kept: ReviewFinding[]; dropped: Array<{ finding: ReviewFinding; reason: string }> } {
  if (scope.mode === 'full') return { kept: findings, dropped: [] };
  const kept: ReviewFinding[] = [];
  const dropped: Array<{ finding: ReviewFinding; reason: string }> = [];
  for (const finding of findings) {
    if (finding.mentionId != null || isOnChangedCode(finding, scope.changed)) {
      kept.push(finding);
    } else if (finding.type === 'improvement' || finding.severity === 'minor') {
      dropped.push({ finding, reason: 'menor o mejora sobre código ya revisado' });
    } else if (finding.evidence.length === 0) {
      dropped.push({ finding, reason: 'sobre código ya revisado sin evidencia' });
    } else {
      kept.push(finding);
    }
  }
  return { kept, dropped };
}

const THREAD_CATEGORY_RE = /<!-- ronin:finding v=2 [^>]*\bcategory=([a-z0-9-]+)/;

// A finding the agent repeated despite the open thread listed in its prompt:
// same file, same category (from the thread's marker) and within a few lines
// of where that thread sits now. Threads without a marker (before the v2
// format) or outdated ones (no current line) are never matched here — the
// agent sees them in the prompt.
const DUPLICATE_LINE_DISTANCE = 5;

export function dedupeAgainstOpenThreads(
  findings: ReviewFinding[],
  threads: BotThread[],
): { kept: ReviewFinding[]; dropped: Array<{ finding: ReviewFinding; threadId: string }> } {
  const open = threads
    .filter((t) => !t.isResolved && t.path != null && t.line != null)
    .map((t) => ({ id: t.id, path: t.path!, line: t.line!, category: THREAD_CATEGORY_RE.exec(t.body)?.[1] }))
    .filter((t) => t.category != null);
  const kept: ReviewFinding[] = [];
  const dropped: Array<{ finding: ReviewFinding; threadId: string }> = [];
  for (const finding of findings) {
    const match = open.find(
      (t) => t.path === finding.path && t.category === slug(finding.category) && Math.abs(t.line - finding.line) <= DUPLICATE_LINE_DISTANCE,
    );
    if (match && finding.mentionId == null) dropped.push({ finding, threadId: match.id });
    else kept.push(finding);
  }
  return { kept, dropped };
}
