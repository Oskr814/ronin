import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeRepo } from './repo-context.js';
import type { ReviewFinding } from './review-output.js';

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
