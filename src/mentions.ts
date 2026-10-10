import { listIssueComments, listReviewComments, hasBotReaction, replyToComment, addReaction, type Comment } from './github.js';
import { classifyMetaCommand, renderMetaReply, type CommandContext } from './help.js';
import { config } from './config.js';
import { log } from './logger.js';

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
    // ronin's own comments are never requests to itself — and its /help
    // reply shows "@<login> /fix-comments" as an example, which would
    // otherwise be picked up as a fresh mention on the next tick, forever.
    if ((comment.authorLogin ?? '').toLowerCase() === botLogin.toLowerCase()) continue;
    const alreadyReacted = comment.reactionsEyes > 0 && (await hasBotReaction(comment.id, comment.kind, botLogin));
    if (!alreadyReacted) unprocessed.push(comment);
  }
  return unprocessed;
}

// Answers /help and misspelled or misplaced commands right here, without
// Claude, and drops them from what the caller gets back — see help.ts. Every
// flow that acts on a mention reads it through findUnprocessedMentions or
// findUnprocessedIssueMentions, so this is the one place that keeps a typo
// from costing a full review-request/external-review/spike run.
//
// A meta-command is dropped even when its reply fails: it's retried as a
// meta-command next tick (no 👀 was added), never handed to a flow that
// would spend an agent run on it.
async function handleMetaCommands(number: number, context: CommandContext, comments: Comment[]): Promise<Comment[]> {
  const login = config.githubLogin;
  const rest: Comment[] = [];
  for (const comment of comments) {
    const meta = classifyMetaCommand(comment.body, login, context);
    if (!meta) {
      rest.push(comment);
      continue;
    }
    try {
      await replyToComment(number, comment, renderMetaReply(meta, login, context));
      await addReaction(comment.id, comment.kind, 'eyes');
    } catch (error) {
      log.error(`respuesta al meta-comando del comentario ${comment.id} falló en #${number}`, error);
    }
  }
  return rest;
}

// Side effect: answers any meta-command among the mentions (see
// handleMetaCommands above) and leaves it out of the result.
export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const [issueComments, reviewComments] = await Promise.all([
    listIssueComments(prNumber),
    listReviewComments(prNumber),
  ]);
  const mentioned = [...issueComments, ...reviewComments].filter((c) => mentionsHandle(c.body, botLogin));
  return handleMetaCommands(prNumber, 'pr', await filterUnprocessed(mentioned));
}

// Same as findUnprocessedMentions (including its meta-command side effect,
// with 'issue' as the context), but for a plain issue rather than a PR:
// skips listReviewComments entirely — a plain issue never has inline review
// comments, and that endpoint (pulls/{n}/comments) errors for a number that
// isn't actually a pull request.
export async function findUnprocessedIssueMentions(issueNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const issueComments = await listIssueComments(issueNumber);
  const mentioned = issueComments.filter((c) => mentionsHandle(c.body, botLogin));
  return handleMetaCommands(issueNumber, 'issue', await filterUnprocessed(mentioned));
}
