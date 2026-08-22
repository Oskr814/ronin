import { listAllOpenExternalPrs, listBotOpenReviewThreads, listExternalOpenReviewThreads, type Comment, type ReviewThread } from './github.js';
import { getLastReviewedSha, pruneLastReviewedSha } from './local-state.js';
import { findUnprocessedMentions, findTrustedFixCommentsCommand } from './mentions.js';
import { config } from './config.js';
import { log } from './logger.js';

export interface ReviewCandidate {
  prNumber: number;
  headRefName: string;
  headSha: string;
  openThreads: ReviewThread[];
  mentions: Comment[];
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

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as mentions.ts. Only fetches openThreads for PRs it's
// actually going to re-review (skips the extra GraphQL call for the common
// case: a PR with no new commits and no fresh @mention since last time).
export async function findPrsNeedingReview(): Promise<{
  reviewCandidates: ReviewCandidate[];
  trustedFixCandidates: TrustedFixCandidate[];
}> {
  const prs = await listAllOpenExternalPrs();
  // Entries for PRs that are no longer open are dead weight — drop them here
  // rather than in a separate cron; this is the one place that already knows
  // the full set of currently-open external PRs.
  await pruneLastReviewedSha(prs.map((pr) => pr.number));
  const reviewCandidates: ReviewCandidate[] = [];
  const trustedFixCandidates: TrustedFixCandidate[] = [];
  for (const pr of prs) {
    // Per-PR isolation: one flaky GraphQL/API call or malformed response must
    // not throw out of the whole loop and zero out review for every other
    // candidate this tick (including ones already collected above).
    try {
      // A fork's code stays untrusted no matter who comments — the trust
      // check on the comment author never even runs for one, so a fork PR
      // can only ever end up in reviewCandidates, never trustedFixCandidates.
      if (!pr.isCrossRepository) {
        const trigger = await findTrustedFixCommentsCommand(pr.number);
        if (trigger.length > 0) {
          const openThreads = await listExternalOpenReviewThreads(pr.number, config.githubLogin);
          trustedFixCandidates.push({ prNumber: pr.number, headRefName: pr.headRefName, trigger, openThreads });
          continue;
        }
      }
      const lastSha = await getLastReviewedSha(pr.number);
      // A comment mentioning the bot doesn't move headRefOid, so an unchanged
      // SHA alone can't rule a PR out anymore — it also needs no pending
      // @mention asking for a fresh look (see docs/superpowers/specs/2026-07-28-mention-review-design.md,
      // whose in-repo counterpart this mirrors for PRs outside ronin's own
      // stack).
      const mentions = await findUnprocessedMentions(pr.number);
      if (lastSha === pr.headRefOid && mentions.length === 0) continue;
      const openThreads = await listBotOpenReviewThreads(pr.number, config.githubLogin);
      reviewCandidates.push({ prNumber: pr.number, headRefName: pr.headRefName, headSha: pr.headRefOid, openThreads, mentions });
    } catch (error) {
      log.error(`findPrsNeedingReview: PR #${pr.number} falló al evaluar elegibilidad, se salta este tick`, error);
    }
  }
  return { reviewCandidates, trustedFixCandidates };
}
