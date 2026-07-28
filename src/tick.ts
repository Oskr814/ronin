import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  setPrState,
  getSpecPathFromPr,
  mergeSpecPr,
  getOpenPrForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './spec-content.js';
import { nextSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask, sliceIndexFromBranch } from './agent-task.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { config } from './config.js';

function prUrl(prNumber: number): string {
  return `https://github.com/${config.productRepo}/pull/${prNumber}`;
}

async function renderTrackingIssueBody(title: string, specPath: string): Promise<string> {
  const template = await readFile(join(process.cwd(), 'templates/tracking-issue.md'), 'utf8');
  return template
    .replaceAll('{{spec_title}}', title)
    .replaceAll('{{spec_repo_url}}', `https://github.com/${config.productRepo}`)
    .replaceAll('{{spec_relative_path}}', specPath);
}

// Discovery source: a human writes the spec as a PR against the product
// repo and labels it with this runner's identity (see claim.ts) once it's
// ready to hand off — marking it ready for review (not draft) is the "go"
// signal. This sidesteps the old race where two machines could each decide
// independently to pick up the same spec: only one label, applied once, by
// a human. See docs/DESIGN.md §1.
async function discoverAssignedSpecs(): Promise<void> {
  const prs = await listAssignedSpecPrs(runnerLabel());
  for (const pr of prs) {
    try {
      // Claimed on the spec PR itself before doing anything else, so a
      // failure partway through doesn't leave it silently re-picked-up
      // (or silently ignored) on a later tick.
      await setPrState(pr.number, 'in-progress');
      const specPath = await getSpecPathFromPr(pr.number);

      // Deliberately skips the approval gate mergePullRequest enforces for
      // implementation PRs — this is documentation, and the human already
      // signaled readiness via the label + undraft. See docs/DESIGN.md §1.
      await mergeSpecPr(pr.number);
      await fetchOriginMain();
      const title = extractTitle(await readSpecFile(specPath), specPath);

      const body = await renderTrackingIssueBody(title, specPath);
      const issue = await createTrackingIssue(`[spec] ${title}`, body);
      // Without this, the issue stays labeled valeria:ready forever and
      // listTrackingIssues('in-progress') would never find it again.
      await setIssueState(issue.number, 'in-progress');
      await tryClaim(issue.number);
      await setPrState(pr.number, 'done');
      // The plan task rewrites the issue body with the real slice checklist.
      await runAgentTask({ type: 'plan', issueNumber: issue.number, specPath });
    } catch (error) {
      await notifyBlocker({
        issueUrl: prUrl(pr.number),
        reason: `Excepción no manejada procesando el spec PR: ${(error as Error).message}`,
      });
      await setPrState(pr.number, 'blocked').catch(() => {});
    }
  }
}

async function blockOnAttemptLimit(
  issue: TrackingIssue,
  pr: PullRequestStatus,
  limit: number,
  reason: string,
): Promise<boolean> {
  const attempts = await incrementAttemptCount(pr.number);
  if (attempts <= limit) return false;

  await notifyBlocker({
    issueUrl: issue.url,
    prUrl: prUrl(pr.number),
    reason,
    excerpt: `PR #${pr.number}, ${attempts} intentos (límite ${limit})`,
  });
  await setIssueState(issue.number, 'blocked');
  return true;
}

async function processIssue(issue: TrackingIssue): Promise<void> {
  const pr = await getOpenPrForIssue(issue.number);

  if (!pr) {
    const slice = await nextSlice(issue.number);
    if (slice === null) {
      // Checklist fully checked but no open PR left: nothing more to do.
      await setIssueState(issue.number, 'done');
      return;
    }
    await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: slice.index, sliceTitle: slice.title });
    return;
  }

  const sliceIndex = sliceIndexFromBranch(pr.headRefName);
  if (sliceIndex !== null) {
    // Idempotent bookkeeping — reconciles the checklist from the PR's own
    // branch name rather than trusting the headless agent's own issue edit
    // to have landed. See docs/DESIGN.md §3.1.
    await recordSlicePr(issue.number, sliceIndex, pr.number);
  }

  // Checked every tick until it succeeds once (hasEvidenceComment gates the
  // repeat work) — the agent may not have finished running e2e yet on an
  // earlier tick, and a slice that doesn't touch e2e-covered behavior just
  // never produces anything to publish, which is fine (publishEvidence
  // returns [] and this silently no-ops). See docs/DESIGN.md §4.
  if (!(await hasEvidenceComment(pr.number))) {
    const paths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
    if (paths.length > 0) {
      await postEvidenceComment(pr.number, paths.map(rawEvidenceUrl));
    }
  }

  if (pr.isDraft) {
    // A draft PR has no checks/review yet by design — that's not a failure
    // state. Left alone until it's marked ready for review (out of scope
    // for this scaffold: nothing currently marks a draft ready).
    return;
  }

  if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
    await mergePullRequest(pr.number);
    if (sliceIndex !== null) await markSliceMerged(issue.number, sliceIndex);

    if (await hasRemainingSlices(issue.number)) return; // next tick picks up the next slice
    await setIssueState(issue.number, 'done');
    return;
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.sliceAttemptLimit,
      'Feedback de review sin converger tras el límite de intentos',
    );
    if (blocked) return;
    await runAgentTask({ type: 'fix-review', issueNumber: issue.number, prNumber: pr.number });
    return;
  }

  if (!pr.checksPassing) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'E2E fallando persistentemente tras el límite de reintentos',
    );
    if (blocked) return;
    await runAgentTask({ type: 'fix-e2e', issueNumber: issue.number, prNumber: pr.number });
    return;
  }

  // Checks passing, no changes requested, not yet approved: normal
  // waiting-for-review state per docs/BLOCKING.md — no action, no notification.
}

export async function tick(): Promise<void> {
  await discoverAssignedSpecs();

  const inProgress = await listTrackingIssues('in-progress');
  for (const issue of inProgress) {
    if (!(await tryClaim(issue.number))) continue; // another runner already owns this one

    try {
      await processIssue(issue);
    } catch (error) {
      await notifyBlocker({
        issueUrl: issue.url,
        reason: `Excepción no manejada procesando el issue: ${(error as Error).message}`,
      });
      await setIssueState(issue.number, 'blocked');
    }
    await releaseIfNoLongerInProgress(issue.number);
  }
}
