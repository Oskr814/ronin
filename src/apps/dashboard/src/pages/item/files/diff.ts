import type { PrFile, DiffThread } from '@platform/github/github.js';
import type { PendingReview, PendingThread, PendingComment } from '@platform/github/github-as-user.js';

// A PR's patches read as lines, and its threads as the person sees them
// (#111): what Archivos draws, without drawing it.

export type { DiffThread, PendingComment, PendingReview, PendingThread, PrFile };

export const BIG_DIFF_LINES = 400;
// How many unchanged lines each "show more" adds.
export const MORE_LINES = 20;
export const FILE_STATUS: Record<string, string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·' };

export type Side = 'LEFT' | 'RIGHT';
export interface Line {
  t: 'add' | 'del' | 'eq';
  // Its number in the old file and in the new one.
  o?: number;
  n?: number;
  text: string;
}
export interface Hunk {
  oldStart: number;
  newStart: number;
  oldEnd: number;
  newEnd: number;
  ctx: string;
  lines: Line[];
}

// A patch's hunks, each line with its number in the old file (o) and the new one (n).
export function parsePatch(patch: string | undefined): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of (patch ?? '').split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (head) {
      o = Number(head[1]);
      n = Number(head[2]);
      hunk = { oldStart: o, newStart: n, oldEnd: 0, newEnd: 0, ctx: head[3], lines: [] };
      hunks.push(hunk);
    } else if (hunk && !raw.startsWith('\\')) {
      const text = raw.slice(1);
      if (raw[0] === '+') hunk.lines.push({ t: 'add', n: n++, text });
      else if (raw[0] === '-') hunk.lines.push({ t: 'del', o: o++, text });
      else hunk.lines.push({ t: 'eq', o: o++, n: n++, text });
    }
  }
  for (const h of hunks) {
    h.newEnd = Math.max(h.newStart - 1, ...h.lines.filter((l) => l.n !== undefined).map((l) => l.n!));
    h.oldEnd = Math.max(h.oldStart - 1, ...h.lines.filter((l) => l.o !== undefined).map((l) => l.o!));
  }
  return hunks;
}
const hunksCache = new Map<string | undefined, Hunk[]>();
export function hunksOf(file: PrFile): Hunk[] {
  if (!hunksCache.has(file.patch)) hunksCache.set(file.patch, parsePatch(file.patch));
  return hunksCache.get(file.patch)!;
}

// A file card's anchor, the same for the same path.
export const fileAnchor = (path: string) => `f-${[...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;

// A thread as Archivos draws it: the PR's, with the replies the person's
// review adds (`pending`), or one their review starts (`mine`).
export type SeenThread = Omit<DiffThread, 'comments'> & { comments: DiffThread['comments']; pending?: PendingComment[]; mine?: boolean };

// A file's threads as the person sees them: the PR's, with the replies their
// review adds, and the ones their review starts.
export function threadsSeen(threads: DiffThread[], review: PendingReview | null, path: string): SeenThread[] {
  const replies = new Map((review?.threads ?? []).filter((t) => !t.isNew).map((t) => [t.id, t.comments]));
  const own: SeenThread[] = threads.filter((t) => t.path === path).map((t) => (replies.has(t.id) ? { ...t, pending: replies.get(t.id) } : t));
  const fresh: SeenThread[] = (review?.threads ?? []).filter((t) => t.isNew && t.path === path).map((t) => ({ ...t, isResolved: false, isOutdated: t.subject === 'line' && t.line === null, url: `pending:${t.id}`, comments: [], pending: t.comments, mine: true }));
  return [...own, ...fresh];
}

// The person's pending comments, each with its thread.
export const pendingOf = (review: PendingReview | null) => (review?.threads ?? []).flatMap((t) => t.comments.map((c) => ({ t, c })));

// The lines a comment is on, as the new file has them: what a suggestion replaces.
export function linesForSuggestion(file: PrFile, c: { startLine?: number; line: number }): string[] {
  const out: string[] = [];
  for (const h of hunksOf(file)) for (const l of h.lines) if (l.n !== undefined && l.n >= (c.startLine ?? c.line) && l.n <= c.line) out.push(l.text);
  return out;
}
