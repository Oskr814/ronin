import { runAgentTask } from '@platform/agents/agent-task.js';
import { getPullRequestStatus, listAllOpenRoninPrs, setReviewStatus, type PullRequestStatus } from '@platform/github/github.js';
import { fetchCommit, isCommitAvailable, pinReviewedSha } from '@platform/git/worktree.js';
import { getInternalReviews, seedInternalReviews, setInternalReview } from '@platform/state/local-state.js';
import { log } from '@platform/logger.js';
import { reviewTask } from './prompts.js';
import { reviewPr } from './publish.js';

// The internal review of ronin's own PRs (#194): all of their code is
// written by AI, so before a person reviews one, the same review that ronin
// runs on other people's PRs goes over it — but nothing of it is published.
// ronin fixes the critical and important findings itself, on the PR's
// branch, and leaves what only a person can decide as questions in the
// description («## Preguntas»), which auto-merge waits on. Minor findings
// and what was already there before the PR are left alone.
//
// Once per head commit: the head it ends on (its fix included) is recorded
// as reviewed, so its own push doesn't start another round, and a later
// commit (an answer to a question, a requested change) is reviewed
// incrementally against it.

const STATUS_CONTEXT = 'ronin/review-interna';

// Whether the PR's head still needs its internal review: not done yet, and
// not already failed on that same commit. The first time, the PRs already
// open are recorded as reviewed (seedInternalReviews) before deciding.
export async function internalReviewDue(pr: Pick<PullRequestStatus, 'number' | 'headRefOid'>): Promise<boolean> {
  if (!(await getInternalReviews()).seeded) await seedInternalReviews(await listAllOpenRoninPrs());
  const { reviewed, failed } = await getInternalReviews();
  return reviewed[pr.number] !== pr.headRefOid && failed[pr.number] !== pr.headRefOid;
}

// The last reviewed commit, when it's still around: the next round only
// looks at what changed since.
async function previousReviewed(prNumber: number): Promise<string | undefined> {
  const sha = (await getInternalReviews()).reviewed[prNumber];
  if (!sha) return undefined;
  if (await isCommitAvailable(sha)) return sha;
  await fetchCommit(sha);
  return (await isCommitAvailable(sha)) ? sha : undefined;
}

export async function runInternalReview(issueNumber: number, pr: PullRequestStatus): Promise<void> {
  const head = pr.headRefOid;
  await setReviewStatus(pr.number, 'pending', 'ronin está revisando su propio código…', { sha: head, context: STATUS_CONTEXT });
  try {
    const previousSha = await previousReviewed(pr.number);
    const run = await reviewPr({
      prNumber: pr.number,
      headRefName: pr.headRefName,
      headSha: head,
      baseRefName: pr.baseRefName,
      ...(previousSha ? { previousSha } : {}),
      threadHistory: [],
      openThreads: [],
      canExecute: true,
      mentions: [],
      own: true,
    });
    const toAttend = run.findings.filter((f) => f.severity !== 'minor' && f.origin?.kind !== 'preexisting');
    log.metric('internal_review', {
      prNumber: pr.number,
      mode: run.scope.mode,
      findings: run.findings.length,
      toAttend: toAttend.length,
      decisions: toAttend.filter((f) => f.type === 'decision').length,
      agentMs: run.agentMs,
    });

    let ended = head;
    if (toAttend.length > 0) {
      await runAgentTask(reviewTask({ type: 'fix-internal-review', issueNumber, prNumber: pr.number, findings: toAttend }));
      ended = (await getPullRequestStatus(pr.number)).headRefOid;
    }
    // Keeps the reviewed commit around for the next round, which is
    // incremental against it; a failure here only costs that.
    await pinReviewedSha(pr.number, ended).catch((error) => log.error(`review interna PR #${pr.number}: no se pudo fijar el SHA revisado`, error));
    await setInternalReview(pr.number, { reviewed: ended });
    const summary = toAttend.length === 0 ? 'Sin hallazgos para atender' : `${toAttend.length} ${toAttend.length === 1 ? 'hallazgo atendido' : 'hallazgos atendidos'}`;
    await setReviewStatus(pr.number, 'success', summary, { sha: ended, context: STATUS_CONTEXT });
  } catch (error) {
    await setInternalReview(pr.number, { failed: head });
    await setReviewStatus(pr.number, 'error', 'La review interna falló: auto-merge espera a una persona', { sha: head, context: STATUS_CONTEXT });
    throw error;
  }
}
