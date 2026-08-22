import { listIssueComments, listReviewComments, hasBotReaction, getCollaboratorPermission, type Comment } from './github.js';
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

const TRUSTED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

// Subset of findUnprocessedMentions: a /fix-comments command left as a
// general comment (never an inline review comment, same rule
// processSlicePr already applies) by someone with real write access to the
// repo. This is the only gate that decides whether a PR ronin didn't open
// gets write access via fix-comments-external — see
// docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
//
// Checks the collaborator-permission endpoint, not GitHub's
// `author_association` field: author_association is derived partly from
// organization membership, and a fine-grained PAT (what this bot
// authenticates with) can't see private org membership — it silently
// downgrades a real member/owner to CONTRIBUTOR from that token's point of
// view. Discovered live: a trusted teammate's /fix-comments command was
// wrongly rejected because ronin's PAT reported CONTRIBUTOR for someone
// whose actual repo permission is admin. collaborators/{login}/permission
// reads the real repo ACL directly and isn't subject to that gap.
export async function findTrustedFixCommentsCommand(prNumber: number): Promise<Comment[]> {
  const unprocessed = await findUnprocessedMentions(prNumber);
  const candidates = unprocessed.filter((c) => c.kind === 'issue' && isFixCommentsCommand(c.body) && c.authorLogin !== '');
  const trusted: Comment[] = [];
  for (const c of candidates) {
    const permission = await getCollaboratorPermission(c.authorLogin);
    if (TRUSTED_PERMISSIONS.has(permission)) trusted.push(c);
  }
  return trusted;
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
