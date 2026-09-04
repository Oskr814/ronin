import { listIssueComments, listReviewComments, hasBotReaction, type Comment } from './github.js';
import { config } from './config.js';

function mentionsHandle(body: string, handle: string): boolean {
  // `handle` is not escaped for regex metacharacters on purpose: it comes from
  // operator-supplied config (RONIN_GITHUB_LOGIN), never from a comment or
  // any other attacker-controlled input, and a GitHub login can only contain
  // alphanumerics and hyphens — none of which are metacharacters.
  return new RegExp(`\\B@${handle}\\b`, 'i').test(body);
}

// A general comment mentioning the bot can additionally carry this command
// to trigger `fix-comments` (batch-address every open review thread the bot
// didn't open) instead of the single-comment `review-request` flow.
export function isFixCommentsCommand(body: string): boolean {
  return /\/fix-comments\b/i.test(body);
}

// Subset of findUnprocessedMentions: a /fix-comments command — general
// comment or inline review-comment reply, either counts, same as
// processSlicePr — left by anyone with a real GitHub identity. This is the
// gate that decides whether a PR ronin didn't open gets write access via
// fix-comments-external — see
// docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
//
// No collaborator-permission check: this used to require 'write'/'maintain'/
// 'admin' via collaborators/{login}/permission, but that endpoint needs the
// PAT's 'Administration' repo permission, which needs org-admin approval to
// grant and isn't reliably available. On a small team where nearly everyone
// already has write access, gating a /fix-comments command on the exact
// permission tier isn't worth that dependency — a non-fork PR already means
// the commenter has real repo access.
export async function findTrustedFixCommentsCommand(prNumber: number): Promise<Comment[]> {
  const unprocessed = await findUnprocessedMentions(prNumber);
  return unprocessed.filter((c) => isFixCommentsCommand(c.body) && c.authorLogin !== '');
}

export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const [issueComments, reviewComments] = await Promise.all([
    listIssueComments(prNumber),
    listReviewComments(prNumber),
  ]);
  const mentioned = [...issueComments, ...reviewComments].filter((c) => mentionsHandle(c.body, botLogin));

  const unprocessed: Comment[] = [];
  for (const comment of mentioned) {
    const alreadyReacted = comment.reactionsEyes > 0 && (await hasBotReaction(comment.id, comment.kind, botLogin));
    if (!alreadyReacted) unprocessed.push(comment);
  }
  return unprocessed;
}
