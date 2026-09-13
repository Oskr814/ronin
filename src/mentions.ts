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

// Triggers the `spike` task on a plain issue — see spike.ts. Distinct from
// isFixCommentsCommand's PR-only command: this one only ever fires on issue
// comments (findTrustedSpikeCommand below never looks at review comments).
export function isSpikeCommand(body: string): boolean {
  return /\/spike\b/i.test(body);
}

const SPIKE_COMMAND_RE = /\/spike\s+(\S+)(?:\s+([\s\S]+))?/i;

// null when the command is missing its required app_name — nothing
// actionable to build a SpikeCandidate from in that case (see spike.ts).
export function parseSpikeCommand(body: string): { appName: string; instruction?: string } | null {
  const match = body.match(SPIKE_COMMAND_RE);
  if (!match) return null;
  const instruction = match[2]?.trim();
  return { appName: match[1], instruction: instruction ? instruction : undefined };
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

// Same trust criterion as findTrustedFixCommentsCommand — see its own doc
// comment for why there's no collaborator-permission-tier check. A plain
// issue has no fork/cross-repository concept the way a PR does, so unlike
// fix-comments-external there's no separate "not a fork" precondition here:
// being able to comment on a private repo's issue at all already implies
// real access.
export async function findTrustedSpikeCommand(issueNumber: number): Promise<Comment[]> {
  const unprocessed = await findUnprocessedIssueMentions(issueNumber);
  return unprocessed.filter((c) => isSpikeCommand(c.body) && c.authorLogin !== '');
}

async function filterUnprocessed(comments: Comment[]): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const unprocessed: Comment[] = [];
  for (const comment of comments) {
    const alreadyReacted = comment.reactionsEyes > 0 && (await hasBotReaction(comment.id, comment.kind, botLogin));
    if (!alreadyReacted) unprocessed.push(comment);
  }
  return unprocessed;
}

export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const [issueComments, reviewComments] = await Promise.all([
    listIssueComments(prNumber),
    listReviewComments(prNumber),
  ]);
  const mentioned = [...issueComments, ...reviewComments].filter((c) => mentionsHandle(c.body, botLogin));
  return filterUnprocessed(mentioned);
}

// Same as findUnprocessedMentions, but for a plain issue rather than a PR:
// skips listReviewComments entirely — a plain issue never has inline review
// comments, and that endpoint (pulls/{n}/comments) errors for a number that
// isn't actually a pull request.
export async function findUnprocessedIssueMentions(issueNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const issueComments = await listIssueComments(issueNumber);
  const mentioned = issueComments.filter((c) => mentionsHandle(c.body, botLogin));
  return filterUnprocessed(mentioned);
}
