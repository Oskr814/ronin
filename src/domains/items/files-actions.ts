import type { RepoEntry } from '@platform/agents/repo-context.js';
import type { Session } from '../access/http.js';
import type { PrFiles } from './files.js';
import { addReviewReply, addReviewThread, commentOnDiff, commentOnIssue, deleteReviewComment, discardReview, editReviewComment, pendingReview, replyToReviewComment, setFileViewed, setThreadResolved, startReview, submitReview, type DiffSpot, type PendingReview, type Posted, type ReviewEvent } from '@platform/github/github-as-user.js';
import { DomainError } from '@platform/errors.js';

// What can be done on a PR's files from the dashboard (#111), as whoever is
// logged in (platform/github/github-as-user.ts): comment a line, a range or the whole file,
// reply in a thread, resolve or reopen it, mark a file as viewed, and the
// review: GitHub's own pending one, then Comment, Approve or Request changes.
// A comment reaches ronin as one written in "Files changed" does: its webhook.
//
// Everything is checked against the PR as last read (items/files.ts): a
// file it changes, a thread or comment it has. GitHub decides the rest (a
// line outside the diff, who may comment).

export class FilesActionError extends DomainError {}

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

const EVENTS: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The person's pending review, started on the commit they're looking at if there was none.
async function reviewFor(session: Session, repo: string, prNumber: number, files: PrFiles, commitId: string): Promise<string> {
  const pending = await pendingReview(session.token, repo, prNumber);
  return pending?.id ?? startReview(session.token, repo, files.prId, commitId);
}

function pendingComment(pending: PendingReview | null, nodeId: unknown) {
  const found = pending?.threads.some((t) => t.comments.some((c) => c.nodeId === nodeId));
  if (!found) throw new FilesActionError('ese comentario no está en tu revisión');
  return nodeId as string;
}

// `review`: the comment or reply goes into the person's pending review
// instead of out at once. `botLogin`: ronin's, to ask it for /fix-comments
// or /auto-merge.
export async function runFilesAction(entry: RepoEntry, prNumber: number, files: PrFiles, session: Session, body: Record<string, unknown>, botLogin: string): Promise<Posted | { ok: true } | { url: string; fixUrl?: string; autoMergeUrl?: string }> {
  const repo = entry.productRepo;
  switch (body.action) {
    case 'comment': {
      const spot = spotOf(body, files);
      if (!body.review) return commentOnDiff(session.token, repo, prNumber, spot, text(body));
      await addReviewThread(session.token, repo, await reviewFor(session, repo, prNumber, files, spot.commitId), spot, text(body));
      return { ok: true };
    }
    case 'reply': {
      const thread = files.threads.find((t) => t.comments.some((c) => c.id === body.commentId));
      if (!thread) throw new FilesActionError('ese comentario no es de este PR');
      if (!body.review) return replyToReviewComment(session.token, repo, prNumber, body.commentId as number, text(body));
      await addReviewReply(session.token, repo, await reviewFor(session, repo, prNumber, files, files.headSha), thread.id, text(body));
      return { ok: true };
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
    case 'pending-edit': {
      const pending = await pendingReview(session.token, repo, prNumber);
      await editReviewComment(session.token, repo, pendingComment(pending, body.commentId), text(body));
      return { ok: true };
    }
    case 'pending-delete': {
      const pending = await pendingReview(session.token, repo, prNumber);
      await deleteReviewComment(session.token, repo, pendingComment(pending, body.commentId));
      return { ok: true };
    }
    case 'discard': {
      const pending = await pendingReview(session.token, repo, prNumber);
      if (!pending) throw new FilesActionError('no tenés una revisión empezada en este PR');
      await discardReview(session.token, repo, pending.id);
      return { ok: true };
    }
    case 'submit': {
      const event = EVENTS.find((e) => e === body.event);
      if (!event) throw new FilesActionError('falta si comentás, aprobás o pedís cambios');
      // GitHub's rule, said before asking it.
      if (event !== 'COMMENT' && same(files.author, session.login)) throw new FilesActionError('no podés aprobar ni pedir cambios en tu propio PR');
      const summary = typeof body.text === 'string' ? body.text.trim() : '';
      if (summary.length > MAX_TEXT) throw new FilesActionError('el resumen es demasiado largo');
      const pending = await pendingReview(session.token, repo, prNumber);
      if (event === 'COMMENT' && !pending && !summary) throw new FilesActionError('no hay nada para mandar: comentá algo o escribí un resumen');
      const commitId = typeof body.commitId === 'string' && /^[0-9a-f]{40}$/.test(body.commitId) ? body.commitId : files.headSha;
      const sent = await submitReview(session.token, repo, { prId: files.prId, commitId, ...(pending ? { pendingId: pending.id } : {}), event, body: summary });
      // ronin doesn't read a review's summary, only its comments, and only
      // acts on them when asked: the ask goes as its own comment, after.
      if (body.fixComments === true && same(files.author, botLogin)) {
        const fix = await commentOnIssue(session.token, repo, prNumber, `@${botLogin} /fix-comments`);
        return { url: sent.url, fixUrl: fix.url };
      }
      // An approval can turn on the PR's auto-merge too, on any PR: the same
      // `/auto-merge` the person would comment, so ronin answers with what's
      // still missing. Never along with /fix-comments: it would merge before
      // ronin got to them.
      if (body.autoMerge === true && event === 'APPROVE') {
        const auto = await commentOnIssue(session.token, repo, prNumber, `@${botLogin} /auto-merge`);
        return { url: sent.url, autoMergeUrl: auto.url };
      }
      return sent;
    }
    default:
      throw new FilesActionError('no existe esa acción');
  }
}
