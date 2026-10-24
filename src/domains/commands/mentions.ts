import { listIssueComments, listRecentIssueComments, listRecentPrComments, listReviewComments, replyToComment, type Comment } from '@platform/github/github.js';
import { eventCommentsFor, inGithubMemo } from '@platform/github/run-memo.js';
import { isProcessed, markProcessed, unprocessed } from '@platform/state/processed-comments.js';
import { classifyMetaCommand, renderMetaReply, type CommandContext } from './help.js';
import { config } from '@platform/config/config.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { launchPreviewWorker } from '../previews/index.js';
import { tableroMentions } from '@platform/commands/mentions.js';
import { applyAutoMergeCommand, type AutoMergeAction } from './auto-merge.js';
import { launchConflictsWorker } from './conflicts.js';
import { log } from '@platform/logger.js';
import { tryLockResource, unlockResource } from '@platform/locks/locks.js';

export function mentionsHandle(body: string, handle: string): boolean {
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

// Turns the issue into a spec PR — see domains/slices/prompts.ts's write-spec. Same
// arguments as /spike: an app and an optional instruction.
export function isSpecCommand(body: string): boolean {
  return /\/spec\b/i.test(body);
}

const SPEC_COMMAND_RE = /\/spec\s+(\S+)(?:\s+([\s\S]+))?/i;

export function parseSpecCommand(body: string): { appName: string; instruction?: string } | null {
  const match = body.match(SPEC_COMMAND_RE);
  if (!match) return null;
  const instruction = match[2]?.trim();
  return { appName: match[1], instruction: instruction ? instruction : undefined };
}

// Triggers an exploration run of one app — see domains/explorations/flow.ts. Issue
// comments only, same as /spike.
export function isExploreCommand(body: string): boolean {
  return /\/explore\b/i.test(body);
}

const EXPLORE_COMMAND_RE = /\/explore\s+([\w.-]+)(?:\s+(\d+))?/i;

export function parseExploreCommand(body: string): { appName: string; maxFunctions?: number } | null {
  const match = body.match(EXPLORE_COMMAND_RE);
  if (!match) return null;
  const max = match[2] ? Number(match[2]) : undefined;
  return { appName: match[1], ...(max && max > 0 ? { maxFunctions: Math.min(max, 10) } : {}) };
}

// Brings the PR's app up on the tailnet, or takes it down — see preview.ts.
// PRs only: handled right here, in findUnprocessedMentions, so it never
// reaches a review or fix-comments flow. Only right after the mention, like
// help.ts's commandToken: "/preview" also shows up in paths
// ("revisá src/domains/previews/card.tsx"), and that's a plain request. `login` isn't
// escaped, same reasoning as mentionsHandle.
//
// `args` is everything after the command, other lines included: an app name
// and/or what the data should look like ("un cliente con 40 catálogos") —
// the worker tells them apart once it knows the manifest's apps (see
// preview.ts's resolvePreviewArgs).
const PREVIEW_STOP_WORDS = ['stop', 'off', 'down'];

// "/preview-stop" (and -off, -down) is the same as "/preview stop": it's how
// people tend to write it, and help.ts lists those as aliases.
export function parsePreviewCommand(body: string, login: string): { action: 'up'; args?: string } | { action: 'stop' } | null {
  const match = body.match(new RegExp(`\\B@${login}\\s+/preview(?:-(${PREVIEW_STOP_WORDS.join('|')}))?(?![\\w/-])([\\s\\S]*)$`, 'i'));
  if (!match) return null;
  if (match[1]) return { action: 'stop' };
  const args = match[2].trim();
  if (PREVIEW_STOP_WORDS.includes(args.toLowerCase())) return { action: 'stop' };
  return args ? { action: 'up', args } : { action: 'up' };
}

// Turns the PR's auto-merge on or off — see auto-merge.ts. Same placement
// rule as /preview: only right after the mention. "/automerge" and
// "/auto-merge-off" (or -stop, -cancel) are read too.
const AUTO_MERGE_OFF_WORDS = ['off', 'stop', 'cancel'];

export function parseAutoMergeCommand(body: string, login: string): AutoMergeAction | null {
  const match = body.match(new RegExp(`\\B@${login}\\s+/auto-?merge(?:-(${AUTO_MERGE_OFF_WORDS.join('|')}))?(?![\\w/-]|\\.\\w)[ \\t]*(\\S*)`, 'i'));
  if (!match) return null;
  return match[1] || AUTO_MERGE_OFF_WORDS.includes(match[2].toLowerCase().replace(/\W+$/, '')) ? 'off' : 'on';
}

// Merges the base into the PR's branch and resolves the conflicts — see
// conflicts.ts. Same placement rule as /preview: only right after the
// mention. "/conflicts", "/fix-conflicts" and "/resolve-conflict" are read
// too, as help.ts lists.
export function isResolveConflictsCommand(body: string, login: string): boolean {
  return new RegExp(`\\B@${login}\\s+/(?:resolve-conflicts?|fix-conflicts|conflicts)(?![\\w/-]|\\.\\w)`, 'i').test(body);
}

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
  return trustedFixCommands(await findUnprocessedMentions(prNumber));
}

// The filter half of findTrustedFixCommentsCommand, for a caller that
// already has the PR's unprocessed mentions and needs them for something
// else too (findPrsNeedingReview) — saves listing them twice.
export function trustedFixCommands(unprocessed: Comment[]): Comment[] {
  return unprocessed.filter((c) => isFixCommentsCommand(c.body) && c.authorLogin !== '');
}

// Mentions left inside a review thread (an inline comment or a reply to
// one), minus /fix-comments commands, which have their own flow. Same trust
// criterion as trustedFixCommands: a real GitHub identity on a non-fork PR.
export function trustedThreadMentions(unprocessed: Comment[]): Comment[] {
  return unprocessed.filter((c) => c.kind === 'review' && !isFixCommentsCommand(c.body) && c.authorLogin !== '');
}

// Same trust criterion as findTrustedFixCommentsCommand — see its own doc
// comment for why there's no collaborator-permission-tier check. A plain
// issue has no fork/cross-repository concept the way a PR does, so unlike
// fix-comments-external there's no separate "not a fork" precondition here:
// being able to comment on a private repo's issue at all already implies
// real access.
export async function findTrustedSpikeCommand(issueNumber: number): Promise<Comment[]> {
  return (await findTrustedIssueCommands(issueNumber)).spike;
}

export interface IssueCommands {
  spike: Comment[];
  explore: Comment[];
  spec: Comment[];
}

// Every issue command from one read of the issue's comments — the tick
// checks every open unmanaged issue for all of them, every time. Each
// mention lands in exactly one bucket, the first command it carries in this
// order. Side effect: a mention with no command (a request in plain words)
// is answered right here with the commands that do work on an issue — ronin
// doesn't take plain-words requests on an issue it wasn't assigned.
export async function findTrustedIssueCommands(issueNumber: number): Promise<IssueCommands> {
  const unprocessed = (await findUnprocessedIssueMentions(issueNumber)).filter((c) => c.authorLogin !== '');
  const commands: IssueCommands = { spike: [], explore: [], spec: [] };
  for (const c of unprocessed) {
    if (isSpikeCommand(c.body)) commands.spike.push(c);
    else if (isExploreCommand(c.body)) commands.explore.push(c);
    else if (isSpecCommand(c.body)) commands.spec.push(c);
    else await answerFreeText(issueNumber, c);
  }
  return commands;
}

// Same as handleMetaCommands' reply: one that fails isn't marked done, and
// is answered on a later tick.
async function answerFreeText(issueNumber: number, comment: Comment): Promise<void> {
  try {
    await claimComment(comment, async () => {
      await replyToComment(issueNumber, comment, renderMetaReply({ kind: 'free-text' }, config.githubLogin, 'issue'));
      await markProcessed(comment);
    });
  } catch (error) {
    log.error(`respuesta al pedido del comentario ${comment.id} falló en #${issueNumber}`, error);
  }
}

async function filterUnprocessed(comments: Comment[]): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  // ronin's own comments are never requests to itself — and its /help
  // reply shows "@<login> /fix-comments" as an example, which would
  // otherwise be picked up as a fresh mention on the next tick, forever.
  const others = comments.filter((c) => (c.authorLogin ?? '').toLowerCase() !== botLogin.toLowerCase());
  return unprocessed(others);
}

// Two processes can list the same unprocessed command at once: an event
// handler going straight to the command (tick.ts's 'pr-commands' flow) and
// the tick's pipeline for that PR's issue, which doesn't wait for it. The
// first to take the comment acts on it; the other, once it gets it, finds
// it already done (processed-comments.ts) and leaves it alone.
async function claimComment(comment: Comment, fn: () => Promise<void>): Promise<void> {
  const resource = `comment-${comment.kind}-${comment.id}`;
  if (!(await tryLockResource(resource))) return;
  try {
    if (await isProcessed(comment)) return;
    await fn();
  } finally {
    await unlockResource(resource);
  }
}

// Answers /help and misspelled or misplaced commands right here, without
// Claude, and drops them from what the caller gets back — see help.ts. Every
// flow that acts on a mention reads it through findUnprocessedMentions or
// findUnprocessedIssueMentions, so this is the one place that keeps a typo
// from costing a full review-request/external-review/spike run.
//
// A meta-command is dropped even when its reply fails: it's retried as a
// meta-command next tick (it wasn't marked done), never handed to a flow that
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
      await claimComment(comment, async () => {
        await replyToComment(number, comment, renderMetaReply(meta, login, context));
        await markProcessed(comment);
      });
    } catch (error) {
      log.error(`respuesta al meta-comando del comentario ${comment.id} falló en #${number}`, error);
    }
  }
  return rest;
}

// Hands every /preview among the mentions to its own worker (preview.ts) and
// drops it from what the caller gets back — same interception point as
// handleMetaCommands, so a preview never costs a review run. It's marked
// done once the worker is launched, which keeps the next tick from launching
// it again; the worker answers in the comment's own place. A launch that
// fails isn't, and is retried next tick.
async function handlePreviewCommands(prNumber: number, comments: Comment[]): Promise<Comment[]> {
  const rest: Comment[] = [];
  for (const comment of comments) {
    const command = comment.authorLogin !== '' ? parsePreviewCommand(comment.body, config.githubLogin) : null;
    if (!command) {
      rest.push(comment);
      continue;
    }
    try {
      await claimComment(comment, async () => {
        launchPreviewWorker({
          repo: activeRepo().productRepo,
          prNumber,
          ...command,
          comment: { id: comment.id, kind: comment.kind },
        });
        await markProcessed(comment);
      });
    } catch (error) {
      log.error(`no se pudo lanzar la preview del comentario ${comment.id} en #${prNumber}`, error);
    }
  }
  return rest;
}

// Hands every /resolve-conflicts to its own worker (conflicts-worker.ts),
// exactly like handlePreviewCommands: done once it's launched, retried next
// tick if the launch fails.
async function handleConflictsCommands(prNumber: number, comments: Comment[]): Promise<Comment[]> {
  const rest: Comment[] = [];
  for (const comment of comments) {
    if (comment.authorLogin === '' || !isResolveConflictsCommand(comment.body, config.githubLogin)) {
      rest.push(comment);
      continue;
    }
    try {
      await claimComment(comment, async () => {
        launchConflictsWorker({ repo: activeRepo().productRepo, prNumber, comment: { id: comment.id, kind: comment.kind } });
        await markProcessed(comment);
      });
    } catch (error) {
      log.error(`no se pudo lanzar /resolve-conflicts del comentario ${comment.id} en #${prNumber}`, error);
    }
  }
  return rest;
}

// Applies every /auto-merge among the mentions right here (it's a label and
// a reply, no worker needed) and drops it from what the caller gets back,
// like handlePreviewCommands. One that fails isn't marked done and is
// retried next tick.
async function handleAutoMergeCommands(prNumber: number, comments: Comment[]): Promise<Comment[]> {
  const rest: Comment[] = [];
  for (const comment of comments) {
    const action = comment.authorLogin !== '' ? parseAutoMergeCommand(comment.body, config.githubLogin) : null;
    if (!action) {
      rest.push(comment);
      continue;
    }
    try {
      await claimComment(comment, () => applyAutoMergeCommand(prNumber, comment, action));
    } catch (error) {
      log.error(`no se pudo aplicar el /auto-merge del comentario ${comment.id} en #${prNumber}`, error);
    }
  }
  return rest;
}

// Side effect: answers any meta-command among the mentions (see
// handleMetaCommands above), launches any /preview (handlePreviewCommands)
// or /resolve-conflicts (handleConflictsCommands), applies any /auto-merge
// (handleAutoMergeCommands), and leaves them all out of the result.
//
// In a tick's run (#370) it looks at the comments of the last days, read
// once for the whole repo (listRecentPrComments): one call per PR, for its
// reviews, instead of three. In the run of an event about a comment on this
// PR, only at what the event brought, with no call at all: an older mention
// still to answer is the next tick's. Anywhere else, at the PR's own, as
// before.
export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const fromEvent = eventCommentsFor(prNumber);
  const recent = fromEvent !== undefined || inGithubMemo();
  const comments = fromEvent
    ?? (recent
      ? await listRecentPrComments(prNumber)
      : (await Promise.all([listIssueComments(prNumber), listReviewComments(prNumber)])).flat());
  const mentioned = comments.filter((c) => mentionsHandle(c.body, botLogin));
  const pending = await withWholeThreads(prNumber, await filterUnprocessed(mentioned), recent);
  const rest = await handleMetaCommands(prNumber, 'pr', pending);
  const github = await handleAutoMergeCommands(prNumber, await handleConflictsCommands(prNumber, await handlePreviewCommands(prNumber, rest)));
  // And what was asked from the tablero in words (#446), waiting in ronin.
  return [...github, ...(await tableroMentions(activeRepo().productRepo, prNumber))];
}

// An inline mention read from the last days may lack the start of its
// thread, which whoever answers it reads: those take it from the PR's own
// comments. Only when there is one, so almost never.
async function withWholeThreads(prNumber: number, pending: Comment[], recent: boolean): Promise<Comment[]> {
  if (!recent || !pending.some((c) => c.kind === 'review')) return pending;
  const whole = new Map((await listReviewComments(prNumber)).map((c) => [`${c.kind}-${c.id}`, c]));
  return pending.map((c) => whole.get(`${c.kind}-${c.id}`) ?? c);
}

// Same as findUnprocessedMentions (including its meta-command side effect,
// with 'issue' as the context), but for a plain issue rather than a PR:
// skips listReviewComments entirely — a plain issue never has inline review
// comments, and that endpoint (pulls/{n}/comments) errors for a number that
// isn't actually a pull request.
// In a tick's run, from the repo's recent comments, with no call of its own;
// in an event's, from the comment it brought.
export async function findUnprocessedIssueMentions(issueNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const issueComments = eventCommentsFor(issueNumber) ?? (inGithubMemo() ? await listRecentIssueComments(issueNumber) : await listIssueComments(issueNumber));
  const mentioned = issueComments.filter((c) => mentionsHandle(c.body, botLogin));
  return handleMetaCommands(issueNumber, 'issue', await filterUnprocessed(mentioned));
}
