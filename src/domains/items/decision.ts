import type { Discussion } from '../../core/github.js';
import type { RepoEntry } from '../../core/repo-context.js';
import type { Session } from '../../apps/api/http/auth.js';
import type { PrFiles } from './files.js';
import { closeIssue, closePr, commentOnIssue, discardReview, pendingReview, submitReview } from '../../core/github-as-user.js';

// What's decided about a PR ronin opened, from its page (#195), as whoever
// is logged in (core/github-as-user.ts): merge it, ask ronin for an adjustment, or
// close it. Each is what the person would do on GitHub — an approval, a
// comment mentioning ronin, closing the PR — so ronin reacts the way it
// already does: /auto-merge, the review-request flow, /fix-comments.
//
// A PR by anyone else keeps GitHub's own review (items/files-actions.ts).

export class DecisionError extends Error {}

export type Decision = 'approve' | 'adjust' | 'close';

// GitHub's own limit on a comment's body.
const MAX_TEXT = 65_536;
const AUTO_MERGE_LABEL = 'ronin:auto-merge';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface DecisionTarget {
  prNumber: number;
  // The issue it closes, if it has one: closing the PR can close it too.
  issueNumber?: number;
  files: PrFiles;
  pr: Discussion;
}

function textOf(body: Record<string, unknown>): string {
  const value = typeof body.text === 'string' ? body.text.trim() : '';
  if (value.length > MAX_TEXT) throw new DecisionError('el texto es demasiado largo');
  return value;
}

// Whether a PR's page offers the decisions: ronin's, open, and not a draft
// (a draft is a spec, which is approved by marking it ready).
export function decidable(pr: Pick<Discussion, 'author' | 'state' | 'isDraft'>, botLogin: string): boolean {
  return same(pr.author, botLogin) && pr.state === 'OPEN' && !pr.isDraft;
}

export async function runDecision(entry: RepoEntry, target: DecisionTarget, session: Session, body: Record<string, unknown>, botLogin: string): Promise<{ url: string; autoMergeUrl?: string; issueUrl?: string }> {
  const repo = entry.productRepo;
  const { prNumber, files, pr } = target;
  if (!decidable(pr, botLogin)) throw new DecisionError('esto es solo para los PRs abiertos de ronin: los demás se revisan con Revisar');
  const pending = await pendingReview(session.token, repo, prNumber);
  switch (body.decision) {
    case 'approve': {
      // The person's pending comments go along with the approval; ronin
      // doesn't act on them (that's what an adjustment is for).
      const sent = await submitReview(session.token, repo, { prId: files.prId, commitId: files.headSha, ...(pending ? { pendingId: pending.id } : {}), event: 'APPROVE', body: '' });
      // Merged once the checks pass: ronin's /auto-merge, unless it's on
      // already or can't merge (conflicts). It answers with what's missing.
      if (pr.labels.includes(AUTO_MERGE_LABEL) || pr.mergeable === 'CONFLICTING') return sent;
      const auto = await commentOnIssue(session.token, repo, prNumber, `@${botLogin} /auto-merge`);
      return { url: sent.url, autoMergeUrl: auto.url };
    }
    case 'adjust': {
      const text = textOf(body);
      // After the mention, a "/" would read as one of its commands.
      if (text.startsWith('/')) throw new DecisionError('para un comando de ronin usá Acciones');
      // With line comments, they're sent as a review and /fix-comments takes
      // them all, with the text as its trigger comment; without, the text
      // alone is a mention: the review-request flow.
      if (pending) {
        await submitReview(session.token, repo, { prId: files.prId, commitId: files.headSha, pendingId: pending.id, event: 'COMMENT', body: '' });
        return commentOnIssue(session.token, repo, prNumber, `@${botLogin} /fix-comments${text ? `\n\n${text}` : ''}`);
      }
      if (!text) throw new DecisionError('escribí qué debería cambiar ronin');
      return commentOnIssue(session.token, repo, prNumber, `@${botLogin} ${text}`);
    }
    case 'close': {
      const reason = textOf(body);
      if (reason) await commentOnIssue(session.token, repo, prNumber, reason);
      if (pending) await discardReview(session.token, repo, pending.id);
      const closed = await closePr(session.token, repo, prNumber);
      // Left open, ronin blocks the issue: a slice without an open PR.
      if (body.closeIssue === true && target.issueNumber !== undefined) {
        const issue = await closeIssue(session.token, repo, target.issueNumber);
        return { url: closed.url, issueUrl: issue.url };
      }
      return closed;
    }
    default:
      throw new DecisionError('no existe esa decisión');
  }
}
