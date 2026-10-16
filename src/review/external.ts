import {
  listAllOpenExternalPrs,
  listBotReviewThreads,
  listAllOpenReviewThreads,
  getLastReviewedShaFromGitHub,
  type BotThread,
  type Comment,
  type ReviewThread,
} from '../core/github.js';
import { isCommitAvailable, fetchCommit, pruneReviewedPins } from '../core/worktree.js';
import { getLastReviewedSha, pruneLastReviewedSha } from '../core/local-state.js';
import { findUnprocessedMentions, trustedFixCommands, trustedThreadMentions } from '../commands/index.js';
import { runWithConcurrency } from '../core/concurrency.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';

export interface ReviewCandidate {
  prNumber: number;
  headRefName: string;
  headSha: string;
  // The branch the PR merges into — its merge base with headSha is what the
  // review's commentable lines are computed against (review/scope.ts).
  baseRefName: string;
  // The SHA the last review of this PR looked at, when there is one and its
  // commit is available locally — the review is incremental against it.
  previousSha?: string;
  // Every thread the bot opened on this PR, open and resolved.
  threadHistory: BotThread[];
  openThreads: ReviewThread[];
  // Whether the review may run the PR's code to verify a finding with a
  // test: only for a branch on this same repo, whose author already has
  // write access. A fork's code is never executed.
  canExecute: boolean;
  mentions: Comment[];
}

// The last reviewed SHA as GitHub shows it (ronin's review marker), else the
// local cache — which also covers reviews published before the marker
// existed. Unusable unless the commit is in the local object store.
async function resolvePreviousSha(prNumber: number, localSha: string | undefined): Promise<string | undefined> {
  const sha = (await getLastReviewedShaFromGitHub(prNumber, config.githubLogin)) ?? localSha;
  if (!sha) return undefined;
  if (await isCommitAvailable(sha)) return sha;
  await fetchCommit(sha);
  if (await isCommitAvailable(sha)) return sha;
  log.info(`external-review PR #${prNumber}: el último SHA revisado (${sha.slice(0, 7)}) no está disponible, se revisa completo`);
  return undefined;
}

// A non-fork PR with a trusted /fix-comments command — see
// docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
// Distinct from ReviewCandidate: no headSha (fix-comments-external always
// targets the PR's current head, same as the internal fix-comments task),
// and trigger/openThreads use the "not opened by the bot" filter instead of
// "opened by the bot".
export interface TrustedFixCandidate {
  prNumber: number;
  headRefName: string;
  trigger: Comment[];
  openThreads: ReviewThread[];
}

// A non-fork PR where someone mentioned ronin inside a review thread — each
// mention is handled in its own thread by thread-reply-external, instead of
// triggering a review of the whole PR.
export interface ThreadMentionCandidate {
  prNumber: number;
  headRefName: string;
  mentions: Comment[];
}

// How many open PRs findPrsNeedingReview evaluates at once — only `gh` reads,
// well under GitHub's secondary rate limits.
const DISCOVERY_CONCURRENCY = 6;

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as mentions.ts. Only fetches openThreads for PRs it's
// actually going to re-review (skips the extra GraphQL call for the common
// case: a PR with no new commits and no fresh @mention since last time).
//
// `only` narrows it to those PRs — an event handler's, for the PR its event
// is about (see tick.ts's Scope).
export async function findPrsNeedingReview(only?: number[]): Promise<{
  reviewCandidates: ReviewCandidate[];
  trustedFixCandidates: TrustedFixCandidate[];
  threadMentionCandidates: ThreadMentionCandidate[];
}> {
  const start = Date.now();
  const open = await listAllOpenExternalPrs();
  const prs = only ? open.filter((pr) => only.includes(pr.number)) : open;
  // Entries for PRs that are no longer open are dead weight — drop them here
  // rather than in a separate cron; this is the one place that already knows
  // the full set of currently-open external PRs. Not on a narrowed run: the
  // list it has isn't every open PR.
  if (!only) {
    await pruneLastReviewedSha(prs.map((pr) => pr.number));
    await pruneReviewedPins(prs.map((pr) => pr.number));
  }
  // Every PR is evaluated independently, several at once: each costs a
  // handful of sequential `gh` calls, and one after another they were most of
  // an idle tick. Results are kept in the PRs' own order.
  const results: Array<{ review?: ReviewCandidate; fix?: TrustedFixCandidate; thread?: ThreadMentionCandidate }> = prs.map(() => ({}));
  await runWithConcurrency(prs.map((pr, index) => ({ pr, index })), DISCOVERY_CONCURRENCY, async ({ pr, index }) => {
    // Per-PR isolation: one flaky GraphQL/API call or malformed response must
    // not throw out of the whole loop and zero out review for every other
    // candidate this tick.
    try {
      // Listed once and used for both decisions below.
      const [mentions, lastSha] = await Promise.all([findUnprocessedMentions(pr.number), getLastReviewedSha(pr.number)]);
      // A fork's code stays untrusted no matter who comments — the trust
      // check on the comment author never even runs for one, so a fork PR
      // can only ever end up in reviewCandidates, never trustedFixCandidates.
      if (!pr.isCrossRepository) {
        const trigger = trustedFixCommands(mentions);
        if (trigger.length > 0) {
          // Every open thread, including ones ronin itself opened in an
          // earlier automatic external-review pass — the trusted human
          // triggering this command gets to decide the bot's own past
          // findings are fair game too, unlike the internal fix-comments
          // task (which only ever sees threads it didn't open itself).
          const openThreads = await listAllOpenReviewThreads(pr.number);
          results[index].fix = { prNumber: pr.number, headRefName: pr.headRefName, trigger, openThreads };
          return;
        }
        // One write flow per PR per tick, same as /fix-comments above: a
        // review running alongside would read a head this run is about to
        // amend. Any general mention waits for the next tick, still
        // unprocessed (not marked done yet).
        const threadMentions = trustedThreadMentions(mentions);
        if (threadMentions.length > 0) {
          results[index].thread = { prNumber: pr.number, headRefName: pr.headRefName, mentions: threadMentions };
          return;
        }
      }
      // A comment mentioning the bot doesn't move headRefOid, so an unchanged
      // SHA alone can't rule a PR out anymore — it also needs no pending
      // @mention asking for a fresh look (see docs/superpowers/specs/2026-07-28-mention-review-design.md,
      // whose in-repo counterpart this mirrors for PRs outside ronin's own
      // stack).
      if (lastSha === pr.headRefOid && mentions.length === 0) return;
      const [threadHistory, previousSha] = await Promise.all([
        listBotReviewThreads(pr.number, config.githubLogin),
        resolvePreviousSha(pr.number, lastSha),
      ]);
      const openThreads = threadHistory.filter((t) => !t.isResolved).map((t) => ({ id: t.id, body: t.body, url: t.url }));
      results[index].review = {
        prNumber: pr.number,
        headRefName: pr.headRefName,
        headSha: pr.headRefOid,
        baseRefName: pr.baseRefName,
        ...(previousSha ? { previousSha } : {}),
        threadHistory,
        openThreads,
        mentions,
        canExecute: !pr.isCrossRepository,
      };
    } catch (error) {
      log.error(`findPrsNeedingReview: PR #${pr.number} falló al evaluar elegibilidad, se salta este tick`, error);
    }
  });
  const reviewCandidates = results.flatMap((r) => (r.review ? [r.review] : []));
  const trustedFixCandidates = results.flatMap((r) => (r.fix ? [r.fix] : []));
  const threadMentionCandidates = results.flatMap((r) => (r.thread ? [r.thread] : []));
  log.metric('review_discovery', {
    durationMs: Date.now() - start,
    openPrs: prs.length,
    reviewCandidates: reviewCandidates.length,
    trustedFixCandidates: trustedFixCandidates.length,
    threadMentionCandidates: threadMentionCandidates.length,
  });
  return { reviewCandidates, trustedFixCandidates, threadMentionCandidates };
}
