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

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Subset of findUnprocessedMentions: a /fix-comments command left as a
// general comment (never an inline review comment, same rule
// processSlicePr already applies) by someone with real write access to the
// repo. This is the only gate that decides whether a PR ronin didn't open
// gets write access via fix-comments-external — see
// docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
export async function findTrustedFixCommentsCommand(prNumber: number): Promise<Comment[]> {
  const unprocessed = await findUnprocessedMentions(prNumber);
  return unprocessed.filter(
    (c) => c.kind === 'issue' && isFixCommentsCommand(c.body) && TRUSTED_ASSOCIATIONS.has(c.authorAssociation),
  );
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
