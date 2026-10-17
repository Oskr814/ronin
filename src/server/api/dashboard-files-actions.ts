import type { RepoEntry } from '../../core/repo-context.js';
import type { Session } from './auth.js';
import type { PrFiles } from './dashboard-files.js';
import { commentOnDiff, replyToReviewComment, setFileViewed, setThreadResolved, type DiffSpot, type Posted } from './github-as-user.js';

// What can be done on a PR's files from the dashboard (#111), as whoever is
// logged in (github-as-user.ts): comment a line, a range or the whole file,
// reply in a thread, resolve or reopen it, mark a file as viewed. A comment
// reaches ronin as one written in "Files changed" does: its webhook.
//
// Everything is checked against the PR as last read (dashboard-files.ts): a
// file it changes, a thread or comment it has. GitHub decides the rest (a
// line outside the diff, who may comment).

export class FilesActionError extends Error {}

// GitHub's own limit on a comment's body.
const MAX_TEXT = 65_536;

function text(body: Record<string, unknown>): string {
  const value = typeof body.text === 'string' ? body.text.trim() : '';
  if (!value) throw new FilesActionError('falta el comentario');
  if (value.length > MAX_TEXT) throw new FilesActionError('el comentario es demasiado largo');
  return value;
}

const lineNumber = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined);

function spotOf(body: Record<string, unknown>, files: PrFiles): DiffSpot {
  const path = typeof body.path === 'string' ? body.path : '';
  if (!files.files.some((f) => f.path === path)) throw new FilesActionError('el PR no cambia ese archivo');
  const commitId = typeof body.commitId === 'string' && /^[0-9a-f]{40}$/.test(body.commitId) ? body.commitId : '';
  if (!commitId) throw new FilesActionError('falta el commit del diff');
  if (body.subject === 'file') return { path, commitId, subject: 'file' };
  const side = body.side === 'LEFT' || body.side === 'RIGHT' ? body.side : undefined;
  const line = lineNumber(body.line);
  const startLine = body.startLine === undefined ? undefined : lineNumber(body.startLine);
  if (!side || !line || (body.startLine !== undefined && (!startLine || startLine > line))) throw new FilesActionError('esa línea no es del diff');
  return { path, commitId, subject: 'line', side, line, ...(startLine !== undefined ? { startLine } : {}) };
}

export async function runFilesAction(entry: RepoEntry, prNumber: number, files: PrFiles, session: Session, body: Record<string, unknown>): Promise<Posted | { ok: true }> {
  const repo = entry.productRepo;
  switch (body.action) {
    case 'comment':
      return commentOnDiff(session.token, repo, prNumber, spotOf(body, files), text(body));
    case 'reply': {
      const known = files.threads.some((t) => t.comments.some((c) => c.id === body.commentId));
      if (!known) throw new FilesActionError('ese comentario no es de este PR');
      return replyToReviewComment(session.token, repo, prNumber, body.commentId as number, text(body));
    }
    case 'resolve': {
      if (!files.threads.some((t) => t.id === body.threadId)) throw new FilesActionError('esa conversación no es de este PR');
      await setThreadResolved(session.token, repo, body.threadId as string, body.resolved !== false);
      return { ok: true };
    }
    case 'viewed': {
      if (!files.files.some((f) => f.path === body.path) || !files.prId) throw new FilesActionError('el PR no cambia ese archivo');
      await setFileViewed(session.token, repo, files.prId, body.path as string, body.viewed !== false);
      return { ok: true };
    }
    default:
      throw new FilesActionError('no existe esa acción');
  }
}
