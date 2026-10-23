import type { Discussion } from '@platform/github/github.js';
import type { RepoEntry } from '@platform/agents/repo-context.js';
import type { Session } from '../access/http.js';
import type { PrFiles } from './files.js';
import { closeIssue, closePr, commentOnIssue, discardReview, pendingReview, submitReview } from '@platform/github/github-as-user.js';
import { DomainError } from '@platform/errors.js';

// What's decided about a PR ronin opened, from its page (#195), as whoever
// is logged in (platform/github/github-as-user.ts): merge it, ask ronin for an adjustment, or
// close it. Each is what the person would do on GitHub — an approval, a
// comment mentioning ronin, closing the PR — so ronin reacts the way it
// already does: /auto-merge, the review-request flow, /fix-comments.
//
// A PR by anyone else keeps GitHub's own review (items/files-actions.ts).

export class DecisionError extends DomainError {}

// `answer`: the answers to the questions its internal review left in the
// description (#194), a mention like an adjustment's, without the pending
// comments of Archivos.
export type Decision = 'approve' | 'adjust' | 'close' | 'answer';

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

// A spec ronin wrote (/spec): its branch is ronin/<issue>/spec.
export const isSpecPr = (pr: Pick<Discussion, 'headRefName'>) => /^ronin\/\d+\/spec$/.test(pr.headRefName ?? '');

// Whether a PR's page offers the decisions: ronin's, open, and not a draft —
// but for a spec, which an older one may still be: approving it is what
// starts it, and ronin takes it out of draft then.
export function decidable(pr: Pick<Discussion, 'author' | 'state' | 'isDraft' | 'headRefName'>, botLogin: string): boolean {
  return same(pr.author, botLogin) && pr.state === 'OPEN' && (!pr.isDraft || isSpecPr(pr));
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
      // A spec: the approval is the go — ronin merges it and starts its
      // slices (discoverAssignedSpecs), no /auto-merge.
      if (isSpecPr(pr)) return sent;
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
      // A spec's comments go to ronin as a review that mentions it: the spec
      // conversation (revise-spec) answers mentions, not /fix-comments.
      if (pending && isSpecPr(pr)) {
        return submitReview(session.token, repo, { prId: files.prId, commitId: files.headSha, pendingId: pending.id, event: 'COMMENT', body: `@${botLogin} ${text || 'atendé los comentarios de esta revisión.'}` });
      }
      if (pending) {
        await submitReview(session.token, repo, { prId: files.prId, commitId: files.headSha, pendingId: pending.id, event: 'COMMENT', body: '' });
        return commentOnIssue(session.token, repo, prNumber, `@${botLogin} /fix-comments${text ? `\n\n${text}` : ''}`);
      }
      if (!text) throw new DecisionError('escribí qué debería cambiar ronin');
      return commentOnIssue(session.token, repo, prNumber, `@${botLogin} ${text}`);
    }
    case 'answer': {
      const text = textOf(body);
      if (!text) throw new DecisionError('elegí o escribí al menos una respuesta');
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
