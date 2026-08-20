import { listAllOpenExternalPrs, listBotOpenReviewThreads, type ReviewThread } from './github.js';
import { getLastReviewedSha } from './local-state.js';
import { config } from './config.js';

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
  const candidates: ReviewCandidate[] = [];
  for (const pr of prs) {
    const lastSha = await getLastReviewedSha(pr.number);
    if (lastSha === pr.headRefOid) continue;
    const openThreads = await listBotOpenReviewThreads(pr.number, config.githubLogin);
    candidates.push({ prNumber: pr.number, headRefName: pr.headRefName, headSha: pr.headRefOid, openThreads });
  }
  return candidates;
}
