import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanReadySpecs, linkSpecToIssue, type SpecFile } from './specs.js';
import {
  createTrackingIssue,
  listTrackingIssues,
  getOpenPrForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { nextSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask, sliceIndexFromBranch } from './agent-task.js';
import { tryClaim, releaseIfNoLongerInProgress } from './claim.js';
import { config } from './config.js';

function prUrl(pr: PullRequestStatus): string {
  return `https://github.com/${config.productRepo}/pull/${pr.number}`;
}

async function renderTrackingIssueBody(spec: SpecFile): Promise<string> {
  const template = await readFile(join(process.cwd(), 'templates/tracking-issue.md'), 'utf8');
  return template
    .replaceAll('{{spec_title}}', spec.title)
    .replaceAll('{{spec_repo_url}}', `https://github.com/${config.productRepo}`)
    .replaceAll('{{spec_relative_path}}', spec.relativePath);
}

async function discoverNewSpecs(): Promise<void> {
  const specs = await scanReadySpecs();
  for (const spec of specs) {
    const body = await renderTrackingIssueBody(spec);
    const issue = await createTrackingIssue(`[spec] ${spec.title}`, body);
    // Without this, the issue stays labeled valeria:ready forever and
    // listTrackingIssues('in-progress') would never find it again on a
    // later tick — found while preparing the first live dry run.
    await setIssueState(issue.number, 'in-progress');
    // Claimed by the same machine that just created it, before any other
    // supervisor's tick could see it as unclaimed in-progress work — see
    // docs/DESIGN.md §9. This doesn't protect against two machines
    // discovering and creating separate issues for the same spec in the
    // same window; that's a distinct, still-open gap (also §9).
    await tryClaim(issue.number);
    await linkSpecToIssue(spec, issue.number);
    // The plan task rewrites the issue body with the real slice checklist.
    await runAgentTask({ type: 'plan', issueNumber: issue.number, specPath: spec.relativePath });
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
    prUrl: prUrl(pr),
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
  await discoverNewSpecs();

  const inProgress = await listTrackingIssues('in-progress');
  for (const issue of inProgress) {
    if (!(await tryClaim(issue.number))) continue; // another machine already owns this one

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
