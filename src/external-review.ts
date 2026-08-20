import { listAllOpenExternalPrs, listBotOpenReviewThreads, type ReviewThread } from './github.js';
import { getLastReviewedSha, pruneLastReviewedSha } from './local-state.js';
import { config } from './config.js';
import { log } from './logger.js';

export interface ReviewCandidate {
  prNumber: number;
  headRefName: string;
  headSha: string;
  openThreads: ReviewThread[];
}

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as mentions.ts. Only fetches openThreads for PRs it's
// actually going to re-review (skips the extra GraphQL call for the common
// case: a PR with no new commits since last time).
export async function findPrsNeedingReview(): Promise<ReviewCandidate[]> {
  const prs = await listAllOpenExternalPrs();
  // Entries for PRs that are no longer open are dead weight — drop them here
  // rather than in a separate cron; this is the one place that already knows
  // the full set of currently-open external PRs.
  await pruneLastReviewedSha(prs.map((pr) => pr.number));
  const candidates: ReviewCandidate[] = [];
  for (const pr of prs) {
    // Per-PR isolation: one flaky GraphQL call or malformed response must not
    // throw out of the whole loop and zero out review for every other
    // candidate this tick (including ones already collected above).
    try {
      const lastSha = await getLastReviewedSha(pr.number);
      if (lastSha === pr.headRefOid) continue;
      const openThreads = await listBotOpenReviewThreads(pr.number, config.githubLogin);
      candidates.push({ prNumber: pr.number, headRefName: pr.headRefName, headSha: pr.headRefOid, openThreads });
    } catch (error) {
      log.error(`findPrsNeedingReview: PR #${pr.number} falló al evaluar elegibilidad, se salta este tick`, error);
    }
  }
  return candidates;
}
