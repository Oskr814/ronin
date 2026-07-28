import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanReadySpecs, linkSpecToIssue, type SpecFile } from './specs.js';
import {
  createTrackingIssue,
  listTrackingIssues,
  getOpenPrForIssue,
  mergePullRequest,
  setIssueState,
  type TrackingIssue,
} from './github.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask } from './agent-task.js';
import { config } from './config.js';

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
    await linkSpecToIssue(spec, issue.number);
    // Slicing the plan into the checklist happens inside this task, once
    // agent-task.ts is implemented — it owns rewriting the issue body.
    await runAgentTask({ type: 'plan', issueNumber: issue.number, specPath: spec.relativePath });
  }
}

async function processIssue(issue: TrackingIssue): Promise<void> {
  const pr = await getOpenPrForIssue(issue.number);

  if (!pr) {
    // TODO: sliceIndex needs to come from the issue's checklist (first
    // unchecked item), not a hardcoded 0 — parsing that back out of the
    // issue body is part of the agent-task.ts design pass.
    await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: 0 });
    return;
  }

  if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
    await mergePullRequest(pr.number);
    // TODO: check the issue's checklist for remaining unchecked slices before
    // marking done — right now this always closes out the issue.
    await setIssueState(issue.number, 'done');
    return;
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    await runAgentTask({ type: 'fix-review', issueNumber: issue.number, prNumber: pr.number });
    return;
  }

  if (!pr.checksPassing) {
    // TODO: this must count attempts against config.e2eRetryLimit /
    // config.sliceAttemptLimit (docs/BLOCKING.md) before blindly retrying —
    // needs the same persistent-counter mechanism as sliceIndex above.
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
    try {
      await processIssue(issue);
    } catch (error) {
      await notifyBlocker({
        issueUrl: issue.url,
        reason: `Excepción no manejada procesando el issue: ${(error as Error).message}`,
      });
      await setIssueState(issue.number, 'blocked');
    }
  }
}
