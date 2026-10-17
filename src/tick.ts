import { markProcessed } from './core/processed-comments.js';
import { linearIdInPr, linearRefFrom, withLinearLink } from './core/linear.js';
import { currentCycle, linearKey } from './core/linear-api.js';
import { processLinearAssignments, queueLinearAssignment } from './core/linear-assign.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  listAssignedIssues,
  addIssueLabel,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  listAllOpenRoninPrs,
  retargetDependents,
  setIssueState,
  incrementAttemptCount,
  attemptCountFromLabels,
  resetAttemptCount,
  isTransientGhError,
  getPullRequestStatus,
  setReviewStatus,
  listExternalOpenReviewThreads,
  setPullRequestBody,
  listIssueComments,
  changesRequestedOnHead,
  getFailedChecks,
  type TrackingIssue,
  type PullRequestStatus,
  type Comment,
} from './core/github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './slices/index.js';
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged, seedSingleSlice, getSlices } from './slices/index.js';
import { notifyBlocker } from './core/notifier.js';
import { resetTickMetrics, getTickAgentMetrics } from './core/metrics.js';
import { runJobs, type Job } from './core/concurrency.js';
import { issueResource, pinResources, prResource, tryLockResource, unlockResource, unpinResources, withResourceLock, withSlots } from './core/locks.js';
import { runAgentTask, type AgentTask } from './core/agent-task.js';
import { runExternalReview } from './review/index.js';
import { ClaudeUsageLimitError } from './core/claude-runner.js';
import { toStackedPrs, pickBottomPr, prsForIssue, planBranch, spikeBranch, issueFromSliceBranch, type StackedPr } from './slices/index.js';
import { incrementChecksPendingCount, resetChecksPendingCount, setLastReviewedSha, recordFailureSignature, pruneFailureSignatures } from './core/local-state.js';
import { failureSignature, type FailureSignature } from './core/failure-signature.js';
import { tryClaim, releaseIfNoLongerInProgress } from './core/claim.js';
import { removeWorktree, sweepOrphanedWorktrees } from './core/worktree.js';
import { findUnprocessedMentions, isFixCommentsCommand } from './commands/index.js';
import { withHelpFooter } from './commands/index.js';
import { findPrsNeedingReview, type ReviewCandidate, type ThreadMentionCandidate, type TrustedFixCandidate } from './review/index.js';
import { findIssueCommands, type ExploreCandidate, type PrototypeCandidate, type RequestCandidate, type SpecCandidate, type SpikeCandidate } from './commands/index.js';
import { processIssueRequest } from './commands/index.js';
import { launchPrototypeWorker } from './commands/index.js';
import { processSpecCandidate } from './slices/index.js';
import { takePendingSpecs } from './core/local-state.js';
import { explorationPrs, exploreWorkerBusy, launchExploreWorker, processExplorationPr } from './exploration/index.js';
import { maybeLaunchNightlyExploration } from './exploration/index.js';
import { sweepPreviews } from './preview/index.js';
import { sweepAutoMerge } from './commands/index.js';
import { checkInterviews, startInterview } from './slices/index.js';
import { findReleasesNeedingChangelog, type ChangelogCandidate } from './changelog/index.js';
import { setLastChangelogRelease } from './core/local-state.js';
import { config, LABEL_DIRECT_ISSUE, LABEL_MANAGED, LABEL_STACK_PRS, LABEL_STATES } from './core/config.js';
import { activeRepo, withActiveRepo } from './core/repo-context.js';
import { loadRepos } from './core/repos.js';
import { log } from './core/logger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Best-effort — prints "unknown" rather than throwing if this checkout ever
// runs without a .git dir (e.g. a packaged install). Exists so a stale
// `dist/` (built from a commit behind origin/main) shows up in the log
// instead of silently running old logic — see
// docs/superpowers/specs/2026-07-28-stacked-prs-design.md, discovered while
// debugging issue #228 stalling on stale code.
async function currentCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function prUrl(prNumber: number): string {
  return `https://github.com/${activeRepo().productRepo}/pull/${prNumber}`;
}

// Exported for direct unit testing — otherwise only reachable through
// discoverAssignedSpecs, which needs a lot of unrelated mocking to exercise.
export async function renderTrackingIssueBody(specPaths: string[]): Promise<string> {
  const template = await readFile(join(process.cwd(), 'templates/tracking-issue.md'), 'utf8');
  const repoUrl = `https://github.com/${activeRepo().productRepo}`;
  // rootBranchName(), not a hardcoded "main": the spec file these links
  // point at was just merged onto the active repo's own base branch, which
  // isn't "main" for every repo (see worktreeBaseRef in repo-context.ts) —
  // a hardcoded "main" here produced a 404 for any repo where it differs.
  const specLinks = specPaths.map((p) => `- [${p}](${repoUrl}/blob/${rootBranchName()}/${p})`).join('\n');
  return template.replaceAll('{{spec_links}}', specLinks);
}

// Prefers a file under a `specs/` subdirectory as the "primary" doc (title,
// issue naming) when a spec PR includes several .md files (e.g. bmedical's
// own convention pairs a specs/<name>-design.md with plans/<name>.md) —
// falls back to the first file if nothing matches that shape.
function primarySpecPath(specPaths: string[]): string {
  return specPaths.find((p) => p.includes('/specs/')) ?? specPaths[0];
}

// A directly-assigned issue (see discoverAssignedIssues below) and a spec's
// tracking issue share the exact same slice-checklist machinery; this is the
// one place that decides which agent prompt a given slice actually needs.
// LABEL_DIRECT_ISSUE (applied only by discoverAssignedIssues, never by a
// human) is what tells the two apart — see
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md (original
// design, since generalized from bug-only intake to any assigned issue).
// Exported for direct unit testing.
export function agentTaskFor(issue: TrackingIssue, sliceIndex: number, sliceTitle: string): AgentTask {
  return issue.labels.includes(LABEL_DIRECT_ISSUE)
    ? { type: 'fix-issue', issueNumber: issue.number, sliceIndex, sliceTitle }
    : { type: 'implement-slice', issueNumber: issue.number, sliceIndex, sliceTitle };
}

// Reads the RONIN_STATUS marker a 'fix-issue' run ends its response with
// (see its prompt in agent-task.ts) to tell "abstained, needs a human answer"
// apart from "opened a PR normally" — the only way the supervisor finds out,
// since runAgentTask's result is otherwise opaque. Exported for direct unit
// testing.
export function needsMoreInfo(agentResult: string): boolean {
  return /RONIN_STATUS:\s*needs-info/i.test(agentResult);
}

// Discovery source: a human writes the spec as a PR against the product
// repo and assigns it to the `ronin` account (GitHub's native Assignees
// field) once it's ready to hand off — marking it ready for review (not
// draft) is the "go" signal. See docs/DESIGN.md §1.
// Returns the tracking issues successfully planned this call — same reason
// as discoverAssignedIssues's own return value: the plan task already ran
// and seeded the slice checklist by the time this returns, but this same
// tick's listTrackingIssues('in-progress') read can still miss the
// just-created issue, delaying its first slice start by a whole tick for no
// reason. See discoverAssignedIssues's doc comment.
async function discoverAssignedSpecs(): Promise<TrackingIssue[]> {
  const started: TrackingIssue[] = [];
  const prs = await listAssignedSpecPrs();
  for (const pr of prs) {
    try {
      // Claimed on the spec PR itself before doing anything else, so a
      // failure partway through doesn't leave it silently re-picked-up
      // (or silently ignored) on a later tick.
      await setPrState(pr.number, 'in-progress');
      const specPaths = await getSpecPathsFromPr(pr.number);
      const primaryPath = primarySpecPath(specPaths);

      // Deliberately skips the approval gate mergePullRequest enforces for
      // implementation PRs — this is documentation, and the human already
      // signaled readiness via the label + undraft. See docs/DESIGN.md §1.
      await mergeSpecPr(pr.number);
      await fetchOriginMain();
      const title = extractTitle(await readSpecFile(primaryPath), primaryPath);

      const body = await renderTrackingIssueBody(specPaths);
      const issue = await createTrackingIssue(`[spec] ${title}`, body);
      // In Linear, into the project of the issue the spec came from (#101):
      // its branch is ronin/<issue>/spec.
      const origin = Number(/^ronin\/(\d+)\/spec$/.exec(pr.headRefName)?.[1]);
      if (Number.isInteger(origin)) await queueLinearAssignment({ number: issue.number, fromIssue: origin }).catch((error) => log.error(`Linear: no se pudo encolar el proyecto de #${issue.number}`, error));
      // Without this, the issue stays labeled ronin:ready forever and
      // listTrackingIssues('in-progress') would never find it again.
      await setIssueState(issue.number, 'in-progress');
      await tryClaim(issue.number);
      await setPrState(pr.number, 'done');
      // The spec PR itself is merged and mostly done at this point — this
      // is the one place a human watching that PR (not the tracking issue)
      // finds out where the actual work moved to.
      await commentOnSpecPr(pr.number, `🚀 Started: tracked in ${issue.url}`);
      // The plan task rewrites the issue body with the real slice checklist.
      // Its worktree never has a PR (see stack.ts's planBranch), so unlike
      // every other task type it never goes through the merge-time cleanup
      // in processSlicePr below — clean it up here instead, right after,
      // regardless of outcome. Nothing about a finished plan run needs to
      // persist: a retry (including after ClaudeUsageLimitError) just
      // recreates the worktree fresh via ensureWorktree.
      // Held while the plan runs: its worktree has no PR, and the tick's
      // sweepOrphanedWorktrees would otherwise take it from under it when an
      // event handler is the one running this.
      const locked = await tryLockResource(issueResource(issue.number));
      try {
        await runAgentTask({ type: 'plan', issueNumber: issue.number, specPaths });
      } finally {
        await removeWorktree(planBranch(issue.number));
        if (locked) await unlockResource(issueResource(issue.number));
      }
      started.push({ number: issue.number, title: `[spec] ${title}`, url: issue.url, labels: [LABEL_MANAGED, LABEL_STATES['in-progress']] });
    } catch (error) {
      // A monthly spend/usage cap is transient and resolves on its own —
      // never a reason to block on a human. Leave state as-is and retry on
      // a later tick. See ClaudeUsageLimitError.
      if (error instanceof ClaudeUsageLimitError) {
        log.info(`spec PR #${pr.number}: límite de uso de Claude alcanzado, reintentando en un tick posterior`);
        continue;
      }
      await notifyBlocker({
        issueUrl: prUrl(pr.number),
        reason: `Excepción no manejada procesando el spec PR: ${(error as Error).message}`,
      });
      await setPrState(pr.number, 'blocked').catch(() => {});
    }
  }
  return started;
}

function issueUrl(issueNumber: number): string {
  return `https://github.com/${activeRepo().productRepo}/issues/${issueNumber}`;
}

// Discovery source: a human assigns any open issue to the `ronin` account
// (GitHub's native Assignees field) — same "andá" signal as a spec PR's
// assignment, but without a draft/ready step or a required label, since a
// GitHub issue has no draft state. Unlike specs, no mirror tracking issue is
// created: the issue itself becomes the tracked unit, seeded with a
// single-slice checklist so the rest of the pipeline (merge gate,
// fix-review/fix-e2e cycles) treats it exactly like a spec's tracking issue.
// Whether there's enough context to act on it is judged per-issue by the
// agent itself (see agent-task.ts's 'fix-issue' prompt and its
// RONIN_STATUS marker, read back in tickOneRepo below) rather than gated
// here by a label. See
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md (original
// design, since generalized from bug-only intake to any assigned issue).
// Returns the issues successfully moved to in-progress this call — see
// tickOneRepo, which merges these into its own listTrackingIssues('in-progress')
// read instead of trusting that read alone. Needed because GitHub's
// issue-list-by-label query can lag a few seconds behind a label this same
// function just applied: without the merge, an issue assigned via webhook
// got labeled ronin:in-progress but its first slice didn't start until the
// *next* tick noticed it — silently defeating the point of reacting to the
// webhook quickly. Discovered live once the cron's reconciliation interval
// was widened (see README.md's Webhooks section) and the gap became visible.
export async function discoverAssignedIssues(): Promise<TrackingIssue[]> {
  const started: TrackingIssue[] = [];
  const issues = await listAssignedIssues();
  for (const issue of issues) {
    try {
      // Added first, before anything else can fail, so a partial failure
      // still leaves the issue ronin-managed (and therefore reachable via
      // listTrackingIssues once set to blocked below) instead of retried
      // forever as "not yet picked up".
      await addIssueLabel(issue.number, LABEL_MANAGED);
      await addIssueLabel(issue.number, LABEL_DIRECT_ISSUE);
      await seedSingleSlice(issue.number, `Fix — ${issue.title}`);
      await setIssueState(issue.number, 'in-progress');
      started.push({
        number: issue.number,
        title: issue.title,
        url: issueUrl(issue.number),
        labels: [LABEL_MANAGED, LABEL_DIRECT_ISSUE, LABEL_STATES['in-progress']],
      });
    } catch (error) {
      await notifyBlocker({
        issueUrl: issueUrl(issue.number),
        reason: `Excepción no manejada procesando el issue asignado: ${(error as Error).message}`,
      });
      await setIssueState(issue.number, 'blocked').catch(() => {});
    }
  }
  return started;
}

async function blockOnAttemptLimit(
  issue: TrackingIssue,
  pr: PullRequestStatus,
  limit: number,
  reason: string,
  countFn: (prNumber: number) => Promise<number> = incrementAttemptCount,
): Promise<boolean> {
  const attempts = await countFn(pr.number);
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

// Failing CI blocks on one of two things (docs/BLOCKING.md): the same
// failure coming back E2E_RETRY_LIMIT+1 times — fix-e2e isn't changing it —
// or E2E_ATTEMPT_HARD_LIMIT attempts in all, when every attempt fails a
// different way (progress, but not converging). Telling those apart takes
// the failure's signature; when the checks can't be read it falls back to
// counting attempts against E2E_RETRY_LIMIT, as before signatures existed.
async function blockOnFailingChecks(issue: TrackingIssue, pr: PullRequestStatus): Promise<boolean> {
  let signature: FailureSignature | undefined;
  try {
    signature = failureSignature(await getFailedChecks(pr.number));
  } catch (error) {
    log.info(`PR #${pr.number}: no se pudo leer la falla de los checks, se cuentan solo los intentos: ${(error as Error).message}`);
  }
  if (!signature) {
    return blockOnAttemptLimit(issue, pr, config.e2eRetryLimit, 'E2E fallando persistentemente tras el límite de reintentos');
  }

  const attempts = await incrementAttemptCount(pr.number);
  const seen = await recordFailureSignature(pr.number, signature.hash);
  log.info(`PR #${pr.number}: falla ${signature.hash} vista ${seen} ${seen === 1 ? 'vez' : 'veces'}, intento ${attempts} — ${signature.sample}`);
  let reason: string | undefined;
  let excerpt = '';
  if (seen > config.e2eRetryLimit) {
    reason = 'La misma falla de CI se repite: fix-e2e no la está cambiando';
    excerpt = `PR #${pr.number}, la misma falla ${seen} veces (límite ${config.e2eRetryLimit}): ${signature.sample}`;
  } else if (attempts > config.e2eAttemptHardLimit) {
    reason = 'E2E sin converger: cada intento falla distinto, pero se agotó el tope de intentos';
    excerpt = `PR #${pr.number}, ${attempts} intentos (tope ${config.e2eAttemptHardLimit}). Última falla: ${signature.sample}`;
  }
  if (!reason) return false;

  await notifyBlocker({ issueUrl: issue.url, prUrl: prUrl(pr.number), reason, excerpt });
  await setIssueState(issue.number, 'blocked');
  return true;
}

// Bare branch name a bottom-of-stack PR's base should point at, e.g.
// "origin/main" -> "main" — this codebase always uses "origin" as the
// remote name elsewhere too (see worktree.ts).
function rootBranchName(): string {
  return (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
}

// ronin no longer rebases the bottom PR onto main: a human merges it, and
// GitHub's "Update branch" covers keeping it current when that matters.
// What's left is making sure its base is the root branch. syncMergedSlices
// retargets any dependent PR onto the merged PR's base (a manual PATCH —
// GitHub does not do this automatically, see retargetDependents). If this
// PR's base still isn't the root branch, that retarget never ran or failed:
// CI only runs against main, and a human merging it would land it on a
// now-dead branch. Retry silently, then escalate like any other "needs a
// human eventually" case. 'blocked' means the issue was just set to
// ronin:blocked by blockOnAttemptLimit.
async function bottomBaseIsRoot(issue: TrackingIssue, pr: StackedPr): Promise<'ok' | 'waiting' | 'blocked'> {
  if (pr.baseRefName === rootBranchName()) return 'ok';
  const blocked = await blockOnAttemptLimit(
    issue, pr, config.retargetRetryLimit,
    `Base del PR del fondo del stack es "${pr.baseRefName}", no "${rootBranchName()}" — el retarget automático nunca corrió`,
  );
  return blocked ? 'blocked' : 'waiting';
}

// Returns whether the issue is still in-progress: false means this PR just
// triggered blockOnAttemptLimit (issue set to ronin:blocked) and the caller
// must stop processing the rest of the stack and skip starting new work.
function logSliceOutcome(issue: TrackingIssue, pr: StackedPr, isBottom: boolean, outcome: string): void {
  log.info(`issue #${issue.number} slice ${pr.sliceIndex + 1} PR #${pr.number}${isBottom ? ' (bottom)' : ''}: ${outcome}`);
}

// The PR's body with "Part of RED-n" (or "Fixes RED-n" on the issue's last
// slice). The identifier comes from the PR itself once linked, or else from
// the Linear bot's comment on the issue; an issue without one leaves the body
// as is.
async function withLinearLinkFor(issue: TrackingIssue, pr: StackedPr): Promise<string> {
  try {
    const id = linearIdInPr(pr.body) ?? linearRefFrom((await listIssueComments(issue.number)).map((c) => ({ author: c.authorLogin, body: c.body })))?.id;
    if (!id) return pr.body;
    const slices = await getSlices(issue.number);
    return withLinearLink(pr.body, id, pr.sliceIndex === slices.length - 1);
  } catch (error) {
    log.error(`no se pudo leer el issue de Linear de #${issue.number}`, error);
    return pr.body;
  }
}

export async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean, waitingTurnPrs?: number[]): Promise<boolean> {
  await recordSlicePr(issue.number, pr.sliceIndex, pr.number);

  // Cheat sheet of commands at the bottom of every PR ronin opens — see
  // help.ts — and the line that links it to the issue's Linear issue, if it
  // has one (linear.ts). Both idempotent, and best-effort: a failed edit only
  // means the PR goes without them until the next tick, never a blocked slice.
  const bodyWithHelp = withHelpFooter(await withLinearLinkFor(issue, pr), config.githubLogin);
  if (bodyWithHelp !== pr.body) {
    try {
      await setPullRequestBody(pr.number, bodyWithHelp);
    } catch (error) {
      log.error(`no se pudo actualizar la descripción del PR #${pr.number}`, error);
    }
  }

  if (pr.isDraft) {
    logSliceOutcome(issue, pr, isBottom, 'draft, esperando');
    return true;
  }

  // The detection call itself is wrapped on purpose: a transient API failure
  // reading comments must stay local to these secondary flows, never reach
  // tick()'s catch and put the whole issue in `blocked` (which also emails a
  // human). See docs/superpowers/specs/2026-07-28-mention-review-design.md.
  // A mention — general comment or inline review-comment reply, either
  // counts — can instead carry /fix-comments: that one goes through the
  // fix-comments batch flow below, never review-request, so it isn't
  // double-processed.
  let mentions: Comment[] = [];
  let commandMentions: Comment[] = [];
  try {
    const allMentions = await findUnprocessedMentions(pr.number);
    commandMentions = allMentions.filter((m) => isFixCommentsCommand(m.body));
    mentions = allMentions.filter((m) => !commandMentions.includes(m));
  } catch (error) {
    log.error(`findUnprocessedMentions failed for PR #${pr.number}`, error);
  }

  try {
    if (mentions.length > 0) {
      await setReviewStatus(pr.number, 'pending', 'ronin está revisando el PR…');
      await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });
      await setReviewStatus(pr.number, 'success', 'Review posteada');

      for (const m of mentions) await markProcessed(m);
      // `pr` was read before a claude -p run that can take up to 30
      // minutes and may itself push a commit, so its checks/review fields
      // can be stale now — re-read before falling through to the merge
      // decision below. Without this, an already-approved, checks-passing
      // PR that merely got mentioned would sit unmerged until whatever
      // processIssue does next (e.g. starting a brand new slice) finishes,
      // since the cron lock is single-flight — not just the usual ~5min
      // tick cadence. See docs/superpowers/specs/2026-07-28-mention-review-design.md.
      pr = { ...pr, ...(await getPullRequestStatus(pr.number)) };
    }
  } catch (error) {
    // Local failure, not the issue-wide catch in tick(): a review-request
    // that doesn't land shouldn't block the slice loop. Nothing was marked
    // done, so the next tick picks these same comments up again.
    if (mentions.length > 0) await setReviewStatus(pr.number, 'error', 'La review falló — ver logs del tick');
    log.error(`review-request failed for PR #${pr.number}`, error);
  }

  // Own try/catch, separate from review-request above: a failure here must
  // never block the mention flow it doesn't depend on, and vice versa.
  try {
    if (commandMentions.length > 0) {
      const openThreads = await listExternalOpenReviewThreads(pr.number, config.githubLogin);
      await setReviewStatus(pr.number, 'pending', 'ronin está resolviendo comentarios…', { context: 'ronin/fix-comments' });
      await runAgentTask({ type: 'fix-comments', issueNumber: issue.number, prNumber: pr.number, trigger: commandMentions, openThreads });
      await setReviewStatus(pr.number, 'success', 'Comentarios atendidos', { context: 'ronin/fix-comments' });
      for (const m of commandMentions) await markProcessed(m);
      // Same staleness concern as the review-request re-read above: this run
      // can push a commit, so re-fetch before the merge decision below.
      pr = { ...pr, ...(await getPullRequestStatus(pr.number)) };
    }
  } catch (error) {
    // Not marked done on failure, so the next tick re-processes the same
    // command comment(s) — same trade-off as review-request above.
    if (commandMentions.length > 0) await setReviewStatus(pr.number, 'error', 'El fix-comments falló — ver logs del tick', { context: 'ronin/fix-comments' });
    log.error(`fix-comments failed for PR #${pr.number}`, error);
  }

  if (isBottom) {
    const status = await bottomBaseIsRoot(issue, pr);
    if (status === 'blocked') return false;
    if (status === 'waiting') {
      logSliceOutcome(issue, pr, isBottom, `base "${pr.baseRefName}" en vez de "${rootBranchName()}", esperando el retarget`);
      return true;
    }

    // ronin never merges a slice PR: the human who approved it merges it
    // whenever it suits them, and syncMergedSlices picks that up on the next
    // tick. A merge that landed minutes after the approval, on ronin's own
    // schedule, was confusing.
    if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
      logSliceOutcome(issue, pr, isBottom, 'aprobado y en verde, esperando el merge de un humano');
      return true;
    }
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    if (!(await changesRequestedOnHead(pr.number))) {
      logSliceOutcome(issue, pr, isBottom, 'changes requested sobre un commit anterior, esperando re-review');
      return true;
    }
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.sliceAttemptLimit,
      'Feedback de review sin converger tras el límite de intentos',
    );
    if (blocked) return false;
    logSliceOutcome(issue, pr, isBottom, 'changes requested, disparando fix-review');
    await runAgentTask({ type: 'fix-review', issueNumber: issue.number, prNumber: pr.number });
    return true;
  }

  // bmedical's CI pipeline only runs against PRs targeting `main`; a
  // non-bottom stacked PR's base is always another slice's branch, so it
  // never gets a statusCheckRollup at all. Evaluating checksPending for it
  // would escalate forever on a state that's actually just "waiting its
  // turn" — see docs/superpowers/specs/2026-07-28-bottom-only-checks-design.md.
  if (!isBottom) {
    // Collapsed into one summary line per issue (see processIssue) instead of
    // logging here directly — a stack of a dozen+ slices otherwise repeats
    // this exact line every tick, drowning out anything actionable in the log.
    if (waitingTurnPrs) waitingTurnPrs.push(pr.number);
    else logSliceOutcome(issue, pr, isBottom, 'esperando su turno (no es el fondo)');
    return true;
  }

  // CI still running (queued/in-progress) reads the same as checksPassing
  // === false — wait for it instead of treating it as an actual failure, so
  // in-flight checks don't trigger a spurious fix-e2e. See final review Fix
  // 6. Uses its own counter/limit (checksPendingRetryLimit), not e2eRetryLimit
  // — per docs/BLOCKING.md, a running CI must never block on its own; this
  // is only a safety net against a workflow that structurally never triggers
  // for this slice, so it needs a much longer budget than "the agent's own
  // fix keeps failing" does. Discovered live: PR #239's Integration Tests
  // alone ran longer than e2eRetryLimit's default 2-minute budget (2 ticks
  // at the 1-tick-per-minute cron cadence), blocking the issue on nothing
  // more than CI still being in progress. Counted in local-state.ts, not as
  // a GitHub label like incrementAttemptCount — a tens-of-ticks limit would
  // otherwise mean a label swap every tick, flooding the issue's timeline.
  if (pr.checksPending) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.checksPendingRetryLimit,
      'CI nunca reportó resultados tras el límite de reintentos',
      incrementChecksPendingCount,
    );
    if (!blocked) logSliceOutcome(issue, pr, isBottom, 'checks pendientes, esperando');
    return !blocked;
  }

  // Checks concluded this tick, pass or fail — clear the pending counter so
  // a slow-but-legitimate run doesn't leave debt that costs a later,
  // unrelated pending wait on this same PR its own budget.
  await resetChecksPendingCount(pr.number);

  if (!pr.checksPassing) {
    if (await blockOnFailingChecks(issue, pr)) return false;
    logSliceOutcome(issue, pr, isBottom, 'checks fallando, disparando fix-e2e');
    await runAgentTask({ type: 'fix-e2e', issueNumber: issue.number, prNumber: pr.number });
    return true;
  }

  // Checks passing, no changes requested, not yet approved: normal
  // waiting-for-review state per docs/BLOCKING.md — no action, no notification.
  logSliceOutcome(issue, pr, isBottom, 'checks OK, esperando review');
  return true;
}

// A slice ready to start, once processIssue has confirmed nothing else in
// this issue's stack needs attention first.
interface NextSliceStart {
  issue: TrackingIssue;
  index: number;
  title: string;
  // Only for the log line's wording — how many open PRs this issue's stack
  // already has (0 for the very first slice).
  stackSize: number;
}

// Slice PRs are merged by a human (see processSlicePr), so ronin finds out
// here instead of at merge time: a slice whose PR is no longer open and was
// merged gets checked off, and any PR stacked on it moves to its base before
// bottomBaseIsRoot looks at it. Returns allPrs with those new bases. The
// merged branch's worktree goes with the next sweepOrphanedWorktrees. A PR
// closed without merging is left alone, so the empty-stack check below still
// escalates it.
async function syncMergedSlices(issue: TrackingIssue, allPrs: PullRequestStatus[]): Promise<PullRequestStatus[]> {
  const open = new Set(allPrs.map((p) => p.number));
  let prs = allPrs;
  for (const slice of await getSlices(issue.number)) {
    if (slice.checked || slice.prNumber === null || open.has(slice.prNumber)) continue;
    const merged = await getPullRequestStatus(slice.prNumber);
    if (merged.state !== 'MERGED') continue;
    await markSliceMerged(issue.number, slice.index);
    await retargetDependents(merged.headRefName, merged.baseRefName);
    prs = prs.map((p) => (p.baseRefName === merged.headRefName ? { ...p, baseRefName: merged.baseRefName } : p));
    log.info(`issue #${issue.number}: slice ${slice.index + 1} mergeada (PR #${merged.number})`);
  }
  return prs;
}

// Exported for direct unit testing — otherwise only reachable through
// tickOneRepo, which needs a lot of unrelated mocking to exercise.
export async function processIssue(issue: TrackingIssue, openPrs: PullRequestStatus[]): Promise<NextSliceStart | null> {
  const allPrs = await syncMergedSlices(issue, openPrs);
  const stack = toStackedPrs(prsForIssue(allPrs, issue.number));

  if (stack.length === 0) {
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      return { issue, index: slice.index, title: slice.title, stackSize: 0 };
    }
    // Checklist vacío del todo (nunca se sembró): el `plan` de un spec, o el
    // seedSingleSlice de un issue asignado (ver discoverAssignedIssues), falló a mitad de
    // camino y dejó el issue con el label `ronin` puesto pero sin ninguna
    // slice en el body. Sin este chequeo, el fallthrough de abajo lo
    // confundiría con "todo mergeó" y lo marcaría done sin que se haya
    // tocado nada — un humano que reintente pasándolo de blocked a
    // in-progress nunca se enteraría. Ver final review Fix 3.
    if ((await getSlices(issue.number)).length === 0) {
      await notifyBlocker({
        issueUrl: issue.url,
        reason: 'El checklist de slices está vacío — el seed/plan inicial nunca llegó a escribirse',
      });
      await setIssueState(issue.number, 'blocked');
      return null;
    }
    // Ningún PR abierto y ninguna slice sin arrancar: o todo mergeó, o algún
    // PR se cerró sin mergear y quedó huérfano (ninguna slice más va a
    // arrancar sola porque el checklist ya tiene un número de PR anotado
    // para todas). hasRemainingSlices distingue ambos casos — si hay algo
    // sin mergear en este segundo caso, no hay forma de que el loop avance
    // solo: escala en vez de quedar en un stall silencioso para siempre.
    if (await hasRemainingSlices(issue.number)) {
      await notifyBlocker({
        issueUrl: issue.url,
        reason: 'Hay slices sin PR abierto ni mergear — probablemente una PR se cerró sin mergear',
      });
      await setIssueState(issue.number, 'blocked');
      return null;
    }
    log.info(`issue #${issue.number}: todas las slices mergeadas, done`);
    await setIssueState(issue.number, 'done');
    return null;
  }

  const bottom = pickBottomPr(stack)!; // stack.length >= 1 acá, chequeado arriba
  const waitingTurnPrs: number[] = [];
  for (const pr of stack) {
    const stillInProgress = await processSlicePr(issue, pr, pr.sliceIndex === bottom.sliceIndex, waitingTurnPrs);
    if (!stillInProgress) return null; // se acaba de bloquear el issue — no arrancar trabajo nuevo
  }
  if (waitingTurnPrs.length > 0) {
    log.info(`issue #${issue.number}: ${waitingTurnPrs.length} PR(s) esperando su turno (no son el fondo): ${waitingTurnPrs.map((n) => `#${n}`).join(', ')}`);
  }

  // With the stack still non-empty, starting the next slice now means it
  // gets stacked on top of the one(s) still in flight — only opt-in via
  // ronin:stack-prs. Without the label, the default is sequential: wait for
  // the stack to empty out (the top branch above, stack.length === 0) before
  // starting anything new.
  if (!issue.labels.includes(LABEL_STACK_PRS)) return null;

  const nextUnstarted = await nextUnstartedSlice(issue.number);
  if (nextUnstarted) {
    return { issue, index: nextUnstarted.index, title: nextUnstarted.title, stackSize: stack.length };
  }
  return null;
}

// Shared error handling for a unit of per-issue work: transient Claude quota
// retries forever, any other unhandled exception counts against
// issueErrorRetryLimit before escalating to a human block. Used by both
// passes in tick() below so neither has to duplicate this policy.
//
// The limit counts errors in a row: a step that goes through resets the
// counter, so errors days apart never add up to a block.
export async function runIssueStep(issue: TrackingIssue, step: () => Promise<void>): Promise<void> {
  try {
    await step();
    const attempts = attemptCountFromLabels(issue.labels);
    if (attempts > 0) {
      await resetAttemptCount(issue.number, attempts)
        .catch((error) => log.info(`issue #${issue.number}: no se pudo reiniciar el contador de errores (${(error as Error).message.split('\n')[0]})`));
    }
  } catch (error) {
    // A monthly spend/usage cap is transient and resolves on its own —
    // skip this issue for this tick instead of blocking it on a human;
    // quota comes back and a later tick picks up where this left off.
    if (error instanceof ClaudeUsageLimitError) {
      log.info(`issue #${issue.number}: límite de uso de Claude alcanzado, reintentando en un tick posterior`);
    } else if (isTransientGhError(error)) {
      // Same for GitHub or the network failing for a moment: not counted.
      log.info(`issue #${issue.number}: GitHub falló de forma pasajera (${(error as Error).message.split('\n').slice(0, 2).join(' — ')}), reintentando en un tick posterior`);
    } else {
      const reason = `Excepción no manejada procesando el issue: ${(error as Error).message}`;
      // This escalation path itself calls gh (incrementAttemptCount,
      // notifyBlocker, setIssueState), and gh can fail transiently too (e.g.
      // a bare HTTP 499 from `gh issue view` — a client-closed-request-style
      // network blip, not a real API error). Without this try/catch, that
      // second failure went unhandled here, escaped this function, and
      // escaped the uncaught `for` loop in tick() below — aborting the
      // entire tick (every other in-progress issue skipped that cycle) over
      // one transient network hiccup. Discovered live. Same treatment as
      // ClaudeUsageLimitError above: log and let the next tick retry: it'll
      // re-run step() from scratch, so this issue isn't stuck either way.
      try {
        const attempts = await incrementAttemptCount(issue.number);
        if (attempts <= config.issueErrorRetryLimit) {
          log.info(`issue #${issue.number}: ${reason} (intento ${attempts}/${config.issueErrorRetryLimit}, reintentando en un tick posterior)`);
        } else {
          await notifyBlocker({ issueUrl: issue.url, reason });
          await setIssueState(issue.number, 'blocked');
        }
      } catch (escalationError) {
        log.info(`issue #${issue.number}: ${reason} (además falló el manejo de la excepción: ${(escalationError as Error).message}; reintentando en un tick posterior)`);
      }
    }
  }
  await releaseIfNoLongerInProgress(issue.number);
}

// One PR's review is fully independent of every other's and of the
// issue-tracking loop above — a failure here must never reach tick()'s
// outer catch (which would mark an unrelated issue `blocked` and email a
// human) nor stop the rest of this tick's candidates. See
// docs/superpowers/specs/2026-08-20-external-pr-review-design.md.
export async function processExternalReviewCandidate(candidate: ReviewCandidate): Promise<void> {
  try {
    await setReviewStatus(candidate.prNumber, 'pending', 'ronin está revisando el PR…', { sha: candidate.headSha });
    // The agent only writes findings.json; validating and publishing it
    // happens in review/publish.ts. See
    // docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md.
    await runExternalReview(candidate);
    await setReviewStatus(candidate.prNumber, 'success', 'Review posteada', { sha: candidate.headSha });
    await setLastReviewedSha(candidate.prNumber, candidate.headSha);
    // Only after a successful run: not being marked done is what makes
    // findUnprocessedMentions treat these same comments as unprocessed and
    // retry them on the next tick — same reasoning as processSlicePr's own
    // loop above.
    for (const m of candidate.mentions) await markProcessed(m);
  } catch (error) {
    await setReviewStatus(candidate.prNumber, 'error', 'La review falló — ver logs del tick', { sha: candidate.headSha });
    log.error(`external-review failed for PR #${candidate.prNumber}`, error);
    // No SHA recorded → the next tick treats this PR as still unreviewed.
  }
}

// Counterpart to processExternalReviewCandidate for the trust-gated write
// path — see docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md.
// Same isolation rationale: a failure here must never reach tick()'s outer
// catch, and must never block review of any other candidate this tick.
export async function processTrustedFixCandidate(candidate: TrustedFixCandidate): Promise<void> {
  try {
    await setReviewStatus(candidate.prNumber, 'pending', 'ronin está resolviendo comentarios…', { context: 'ronin/fix-comments' });
    await runAgentTask({
      type: 'fix-comments-external',
      prNumber: candidate.prNumber,
      headRefName: candidate.headRefName,
      trigger: candidate.trigger,
      openThreads: candidate.openThreads,
    });
    await setReviewStatus(candidate.prNumber, 'success', 'Comentarios atendidos', { context: 'ronin/fix-comments' });
    // Only after a successful run — same reasoning as processSlicePr's own
    // loop: not being marked done is what makes
    // findTrustedFixCommentsCommand treat this comment as unprocessed and
    // retry it on the next tick.
    for (const m of candidate.trigger) await markProcessed(m);
  } catch (error) {
    await setReviewStatus(candidate.prNumber, 'error', 'El fix-comments falló — ver logs del tick', { context: 'ronin/fix-comments' });
    log.error(`fix-comments-external failed for PR #${candidate.prNumber}`, error);
  }
}

// Mentions inside review threads of a non-fork PR ronin didn't open — each
// one is handled in its own thread. Same isolation as
// processTrustedFixCandidate, and the same retry: not marked done on failure.
export async function processThreadMentionCandidate(candidate: ThreadMentionCandidate): Promise<void> {
  try {
    await setReviewStatus(candidate.prNumber, 'pending', 'ronin está atendiendo comentarios…', { context: 'ronin/thread-reply' });
    await runAgentTask({
      type: 'thread-reply-external',
      prNumber: candidate.prNumber,
      headRefName: candidate.headRefName,
      mentions: candidate.mentions,
    });
    await setReviewStatus(candidate.prNumber, 'success', 'Comentarios atendidos', { context: 'ronin/thread-reply' });
    for (const m of candidate.mentions) await markProcessed(m);
  } catch (error) {
    await setReviewStatus(candidate.prNumber, 'error', 'La respuesta en el hilo falló — ver logs del tick', { context: 'ronin/thread-reply' });
    log.error(`thread-reply-external failed for PR #${candidate.prNumber}`, error);
  }
}

// Deliberately its own exported function, called before (and independently
// of) the ronin-PR loop: external review shares nothing with that flow, so a
// transient `listAllOpenRoninPrs` failure — which returns early from the
// issue pipeline — must not silently skip external review for the whole
// tick. See final review Fix 4.
export async function externalReviewJobs(only?: number[]): Promise<TickJob[]> {
  let reviewCandidates: ReviewCandidate[];
  let trustedFixCandidates: TrustedFixCandidate[];
  let threadMentionCandidates: ThreadMentionCandidate[];
  try {
    ({ reviewCandidates, trustedFixCandidates, threadMentionCandidates } = await findPrsNeedingReview(only));
  } catch (error) {
    log.info(`tick: findPrsNeedingReview falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return [];
  }
  return [
    ...trustedFixCandidates.map((c) => prJob('fix-comments-external', c.prNumber, () => processTrustedFixCandidate(c))),
    ...threadMentionCandidates.map((c) => prJob('thread-reply-external', c.prNumber, () => processThreadMentionCandidate(c))),
    ...reviewCandidates.map((c) => prJob('external-review', c.prNumber, () => processExternalReviewCandidate(c))),
  ];
}

export async function runExternalReviews(): Promise<void> {
  await runJobs(await externalReviewJobs(), config.tickConcurrency, JOB_CAPS);
}

// A /spike is fully independent of every other flow this tick runs — a
// failure here must never reach tick()'s outer catch (which would mark an
// unrelated issue `blocked` and email a human) nor block any other
// candidate. Same isolation rationale as processExternalReviewCandidate.
export async function processSpikeCandidate(candidate: SpikeCandidate): Promise<void> {
  try {
    await runAgentTask({
      type: 'spike',
      issueNumber: candidate.issueNumber,
      appName: candidate.appName,
      instruction: candidate.instruction,
      trigger: candidate.trigger,
    });
    // Only after a successful run — not being marked done is what makes
    // findTrustedSpikeCommand treat this same comment as unprocessed and
    // retry it on a later tick, same reasoning as every other command
    // trigger in this file.
    for (const m of candidate.trigger) await markProcessed(m);
  } catch (error) {
    log.error(`spike falló para issue #${candidate.issueNumber}`, error);
  } finally {
    // 'spike' never opens a PR (see agent-task.ts) so it never goes through
    // the merge-time worktree cleanup below — same reasoning as
    // discoverAssignedSpecs's own cleanup of planBranch.
    await removeWorktree(spikeBranch(candidate.issueNumber)).catch(() => {});
  }
}

// Deliberately its own exported function, called before (and independently
// of) the ronin-PR loop — same reasoning as runExternalReviews: a transient
// listOpenUnmanagedIssues failure must not silently skip every other flow
// this tick.
export async function spikeJobs(only?: number[]): Promise<TickJob[]> {
  let candidates: SpikeCandidate[];
  let explores: ExploreCandidate[];
  let specs: SpecCandidate[];
  let prototypes: PrototypeCandidate[];
  let requests: RequestCandidate[];
  try {
    ({ spikes: candidates, explores, specs, prototypes, requests } = await findIssueCommands(only));
  } catch (error) {
    log.info(`tick: findIssueCommands falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return [];
  }
  // /spec runs whose interview just got its answers (see interview.ts).
  // Taken from the queue as they're read, so only by a run that will look
  // at every issue — a narrowed one would drop the rest.
  const resumed: SpecCandidate[] = (only ? [] : await takePendingSpecs().catch(() => []))
    .filter((p) => !specs.some((s) => s.issueNumber === p.issueNumber))
    .map((p) => ({ ...p, trigger: [] }));
  return [
    ...candidates.map((c) => issueJob('spike', c.issueNumber, () => processSpikeCandidate(c))),
    ...[...specs, ...resumed].map((c) => issueJob('spec', c.issueNumber, () => processSpecCandidate(c))),
    ...explores.slice(0, 1).map((c) => issueJob('explore-launch', c.issueNumber, () => launchExploreCandidate(c))),
    ...prototypes.map((c) => issueJob('prototype-launch', c.issueNumber, () => launchPrototypeCandidate(c))),
    ...requests.map((c) => issueJob('issue-request', c.issueNumber, () => processRequestCandidate(c))),
  ];
}

// Plain-words mentions on one issue, one after the other: they share the
// issue's body and the request worktree. Each is answered on its own (see
// issue-request.ts, which never throws).
export async function processRequestCandidate(candidate: RequestCandidate): Promise<void> {
  for (const comment of candidate.trigger) await processIssueRequest({ issueNumber: candidate.issueNumber, trigger: comment });
}

// A /prototype never runs inside the tick: it brings a whole app up. Its
// worker waits for the per-repo prototype lock itself, so it's launched
// right away; it's marked done once it is, which keeps the next tick from
// launching it again. A launch that fails isn't, and is retried.
export async function launchPrototypeCandidate(candidate: PrototypeCandidate): Promise<void> {
  try {
    launchPrototypeWorker({
      repo: activeRepo().productRepo,
      issueNumber: candidate.issueNumber,
      appName: candidate.appName,
      ...(candidate.instruction ? { instruction: candidate.instruction } : {}),
      commentId: candidate.trigger[0].id,
    });
    for (const m of candidate.trigger) await markProcessed(m);
  } catch (error) {
    log.error(`issue #${candidate.issueNumber}: no se pudo lanzar el prototipo`, error);
  }
}

// An /explore never runs inside the tick: it can take an hour, and the tick
// is single-flight. It starts a separate worker process (see
// exploration/flow.ts) — one per repo at a time; while one runs, the next
// command waits for a later tick (not marked done, so it's picked up again).
export async function launchExploreCandidate(candidate: ExploreCandidate): Promise<void> {
  if (await exploreWorkerBusy()) {
    log.info(`issue #${candidate.issueNumber}: /explore esperando, ya hay una exploración corriendo en este repo`);
    return;
  }
  launchExploreWorker({
    repo: activeRepo().productRepo,
    appName: candidate.appName,
    ...(candidate.maxFunctions ? { maxFunctions: candidate.maxFunctions } : {}),
    trigger: { issueNumber: candidate.issueNumber, commentIds: candidate.trigger.map((c) => c.id) },
  });
}

// The open exploration PR: reviewers' comments on findings applied (and
// after images redone by the worker), merged into issues once approved — see
// exploration/flow.ts's processExplorationPr. Each PR isolated like every
// other flow here.
export async function explorationPrJobs(): Promise<TickJob[]> {
  let prs;
  try {
    prs = await explorationPrs();
  } catch (error) {
    log.info(`tick: explorationPrs falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return [];
  }
  return prs.map((pr) => prJob('exploration-pr', pr.number, () => processExplorationPr(pr).catch((error) => log.error(`exploración: PR #${pr.number} falló`, error))));
}

export async function runSpikes(): Promise<void> {
  await runJobs(await spikeJobs(), config.tickConcurrency, JOB_CAPS);
}

// A release's changelog entry is fully independent of every other flow this
// tick runs — a failure here must never reach tick()'s outer catch (which
// would mark an unrelated issue `blocked` and email a human) nor block any
// other candidate. Same isolation rationale as processExternalReviewCandidate/
// processSpikeCandidate. Unlike those, this always advances
// lastChangelogRelease regardless of outcome (success or a thrown error) —
// there's no meaningful retry here (an already-published entry doesn't need
// re-publishing), so the alternative is re-processing — and re-emailing —
// the same release forever.
export async function processChangelogCandidate(candidate: ChangelogCandidate): Promise<void> {
  const { release } = candidate;
  try {
    await runAgentTask({ type: 'update-changelog', release });
  } catch (error) {
    log.error(`update-changelog falló para release ${release.tagName}`, error);
    await notifyBlocker({
      issueUrl: release.url,
      reason: `Excepción no manejada generando la entrada de changelog: ${(error as Error).message}`,
    });
  } finally {
    await setLastChangelogRelease(release.tagName, release.publishedAt);
  }
}

// Deliberately its own exported function, called before (and independently
// of) the ronin-PR loop — same reasoning as runExternalReviews/runSpikes. A
// transient findReleasesNeedingChangelog failure must not silently skip
// every other flow this tick, and must not advance lastChangelogRelease
// (the next tick just re-lists and retries). No-op for a repo without
// changelogRepo configured — see findReleasesNeedingChangelog.
//
// Sequential on purpose (JOB_CAPS.changelog = 1): every candidate here shares
// the same changelogRepoPath checkout (see changelog.ts's
// ensureChangelogRepoUpToDate), so two running at once would race the same
// working tree and clobber each other's commit.
export async function changelogJobs(): Promise<TickJob[]> {
  let candidates: ChangelogCandidate[];
  try {
    candidates = await findReleasesNeedingChangelog();
  } catch (error) {
    log.info(`tick: findReleasesNeedingChangelog falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return [];
  }
  return candidates.map((c) => ({ kind: 'changelog', label: c.release.tagName, lock: 'changelog', resources: ['changelog'], run: () => processChangelogCandidate(c) }));
}

export async function runChangelogUpdates(): Promise<void> {
  await runJobs(await changelogJobs(), config.tickConcurrency, JOB_CAPS);
}

// Per-kind limits inside a tick's single job pool (config.tickConcurrency
// overall): external reviews are the heaviest run on the account's quota —
// three at once once exhausted its session limit — and changelog jobs share
// one checkout.
const JOB_CAPS: Record<string, number> = {
  get 'external-review'() {
    return config.externalReviewConcurrency;
  },
  changelog: 1,
  // Both write the same week's exploration checkout.
  'exploration-pr': 1,
  'explore-launch': 1,
};

// A unit of a run's work and what it touches. `lock` is held while it runs
// (locks.ts): the cron tick and an event handler never work on the same
// issue or PR at once — whoever comes second skips it (the tick) or already
// waited for it (a handler, see runScoped). `resources` is what an event's
// Scope is matched against.
export interface TickJob extends Job {
  lock: string;
  resources: string[];
}

function prJob(kind: string, prNumber: number, run: () => Promise<void>): TickJob {
  return { kind, label: `PR #${prNumber}`, lock: prResource(prNumber), resources: [prResource(prNumber)], run };
}

function issueJob(kind: string, issueNumber: number, run: () => Promise<void>): TickJob {
  return { kind, label: `issue #${issueNumber}`, lock: issueResource(issueNumber), resources: [issueResource(issueNumber)], run };
}

// Jobs that never run an agent — they answer, launch a worker or apply a
// label — so they don't take a slot of the quota, and never wait behind
// three long `claude -p` runs to answer a /help.
const NO_SLOT_KINDS = new Set(['pr-commands', 'idle-commands', 'prototype-launch', 'explore-launch']);

// The job as it runs: holding its lock, then a slot of the runner-wide
// quota (shared with every other process, see locks.ts's withSlots) — the
// same limits runJobs keeps inside this one.
function guarded(job: TickJob): Job {
  return {
    kind: job.kind,
    label: job.label,
    run: async () => {
      const work = NO_SLOT_KINDS.has(job.kind) ? job.run : () => withSlots(job.kind, config.tickConcurrency, JOB_CAPS, job.run, job.label);
      const ran = await withResourceLock(job.lock, 'skip', work);
      if (!ran) log.info(`${job.kind} ${job.label}: ya lo está atendiendo otro proceso, se salta`);
    },
  };
}

// One job per in-progress issue: its whole pipeline (fixes, then a possible
// new-slice start) as one unit, holding the issue — and with it every PR of
// its stack.
function issueJobs(inProgress: TrackingIssue[], allPrs: PullRequestStatus[]): TickJob[] {
  return inProgress.map((issue) => ({
    kind: 'issue',
    label: `#${issue.number}`,
    lock: issueResource(issue.number),
    resources: [issueResource(issue.number), ...prsForIssue(allPrs, issue.number).map((pr) => prResource(pr.number))],
    run: async () => {
      if (!(await tryClaim(issue.number))) return; // another runner already owns this one
      await runIssueStep(issue, async () => {
        const next = await processIssue(issue, allPrs);
        if (!next) return;
        const context = next.stackSize === 0
          ? 'sin PRs abiertos'
          : `stack de ${next.stackSize} PR(s) abierto(s)`;
        log.info(`issue #${next.issue.number}: ${context}, arrancando slice ${next.index + 1} (${next.title})`);
        const task = agentTaskFor(next.issue, next.index, next.title);
        const result = await runAgentTask(task);
        // fix-issue is the only task type that may legitimately abstain
        // (issue lacks enough context — see its prompt in agent-task.ts) and
        // end without opening a PR. Without this, the issue would stay
        // labeled ronin:in-progress forever and get retried, unattended,
        // every single tick — see the discoverAssignedIssues design note.
        if (task.type === 'fix-issue' && needsMoreInfo(result)) {
          await setIssueState(next.issue.number, 'blocked');
          // A faster channel for the answers than waiting on comments — see
          // interview.ts. Best effort: the questions are on the issue anyway.
          await startInterview(next.issue.number, next.issue.url).catch((error) => log.error(`issue #${next.issue.number}: no se pudo abrir la entrevista`, error));
        }
      });
    },
  }));
}

// A slice PR is only processed while its issue is in progress, and that's
// where its mentions are read. Once the issue is blocked (or done with a PR
// left open), nothing read them: a /preview on Bmedical/bmedical#367, whose
// issue a transient gh error had blocked, went unanswered. Commands don't
// depend on the issue — findUnprocessedMentions answers /help and typos,
// launches /preview and applies /auto-merge on its own — so they're handled
// here for those PRs. A request in plain words waits for the issue to be
// back in progress, as before.
export function idleCommandJobs(allPrs: PullRequestStatus[], inProgress: TrackingIssue[]): TickJob[] {
  const active = new Set(inProgress.map((issue) => issue.number));
  return allPrs.flatMap((pr) => {
    const issue = issueFromSliceBranch(pr.headRefName);
    if (issue === null || active.has(issue)) return [];
    return [{
      ...prJob('idle-commands', pr.number, async () => {
        await findUnprocessedMentions(pr.number)
          .catch((error) => log.error(`PR #${pr.number}: no se pudieron leer los comandos (issue #${issue} no está en curso)`, error));
      }),
      resources: [prResource(pr.number), issueResource(issue)],
    }];
  });
}

// A command on a PR (help, /preview, /resolve-conflicts, /auto-merge — see
// server/api/webhooks/events.ts), straight to what answers it: findUnprocessedMentions,
// nothing else. Any plain-words mention it leaves is picked up by its usual
// flow; mentions.ts's claimComment keeps the two from answering one twice.
function commandJob(prNumber: number): TickJob {
  return prJob('pr-commands', prNumber, async () => {
    await findUnprocessedMentions(prNumber).catch((error) => log.error(`PR #${prNumber}: no se pudieron atender los comandos`, error));
  });
}

// A bug-fix PR's "Closes #N" (see
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md) makes GitHub
// close the issue as soon as a human merges it, and listTrackingIssues only
// reads open issues, so processIssue never sees it again to mark it done.
// This finishes those off. One closed with slices still unmerged (closed by
// hand mid-work) keeps its label: that's a human's call.
async function finishClosedIssues(): Promise<void> {
  for (const issue of await listTrackingIssues('in-progress', 'closed')) {
    await syncMergedSlices(issue, []);
    if (!(await hasRemainingSlices(issue.number))) {
      await setIssueState(issue.number, 'done');
      log.info(`issue #${issue.number}: cerrado con todas sus slices mergeadas, done`);
    }
  }
}

// The flows a run goes through. The cron tick runs every one of them, over
// everything; an event handler (server/api/webhooks/handler.ts) only the ones its event
// can move — see server/api/webhooks/events.ts's scopeForEvent.
export type Flow =
  | 'interviews'
  | 'assign'
  | 'sweeps'
  | 'auto-merge'
  | 'issues'
  | 'idle-commands'
  | 'pr-commands'
  | 'review'
  | 'issue-commands'
  | 'changelog'
  | 'exploration'
  | 'nightly';

// What an event handler's run covers: its flows, and of their jobs only the
// ones touching one of `resources` (issue-N, pr-N, changelog — see locks.ts).
export interface Scope {
  flows: Flow[];
  resources: string[];
}

// A repo-wide step (assignments, sweeps, auto-merge), under a lock of its
// own so two processes never run it at once: the tick skips it when it's
// taken, a handler waits for it. Never holds anything else while it waits —
// whoever has a step's lock is running it, not waiting — so it can't
// deadlock with the resources a handler pinned.
async function repoStep(scope: Scope | undefined, flow: Flow, fn: () => Promise<void>): Promise<void> {
  if (scope && !scope.flows.includes(flow)) return;
  const ran = await withResourceLock(flow, scope ? 'wait' : 'skip', fn);
  if (!ran) log.info(`${flow}: ya lo está haciendo otro proceso, se salta`);
}

function numbersOf(resources: string[], prefix: 'pr' | 'issue'): number[] {
  return resources.flatMap((r) => (r.startsWith(`${prefix}-`) ? [Number(r.slice(prefix.length + 1))] : []));
}

// The issues of the repo's current Linear cycle first (#101), each group in
// its usual order: when there are more issues than slots
// (TICK_CONCURRENCY), the cycle's get them first. Only on the cron pass — an
// event's run is about one issue anyway. Without a Linear key, or if Linear
// fails, the order stays as it was.
export async function cycleFirst(issues: TrackingIssue[]): Promise<TrackingIssue[]> {
  const key = linearKey(activeRepo());
  if (!key || issues.length < 2) return issues;
  try {
    const cycle = await currentCycle(activeRepo(), key);
    const inCycle = new Set(cycle?.issues.flatMap((i) => (i.githubNumber !== undefined ? [i.githubNumber] : [])) ?? []);
    const first = issues.filter((i) => inCycle.has(i.number));
    if (first.length > 0) log.info(`ciclo ${cycle!.number} de Linear: primero ${first.map((i) => `#${i.number}`).join(', ')}`);
    return [...first, ...issues.filter((i) => !inCycle.has(i.number))];
  } catch (error) {
    log.info(`Linear: no se pudo leer el ciclo actual, sigue el orden de siempre (${(error as Error).message.split('\n')[0]})`);
    return issues;
  }
}

async function tickOneRepo(scope?: Scope): Promise<void> {
  const start = Date.now();
  resetTickMetrics();
  const runs = (flow: Flow) => !scope || scope.flows.includes(flow);
  if (scope) log.info(`evento en ${activeRepo().productRepo}: ${scope.flows.join(', ')} sobre ${scope.resources.join(', ')}`);
  else log.info(`tick start (commit ${await currentCommit()}, repo ${activeRepo().productRepo})`);
  // Closes answered or expired Remote Control interviews; an answered one
  // puts its issue back in progress before this tick lists the work.
  await repoStep(scope, 'interviews', () => checkInterviews().catch((error) => log.error('entrevistas: no se pudieron revisar', error)));
  let justStarted: TrackingIssue[] = [];
  await repoStep(scope, 'assign', async () => {
    justStarted = [...(await discoverAssignedSpecs()), ...(await discoverAssignedIssues())];
  });
  // The Linear projects and cycles still owed to issues ronin opened (#101);
  // a failure is only logged, and retried next tick.
  if (!scope) await processLinearAssignments().catch((error) => log.error('Linear: no se pudieron aplicar los proyectos pendientes', error));

  // What closed PRs leave behind: issues a merge finished, previews, and
  // the worktrees of slices no longer open — sweepOrphanedWorktrees skips
  // the issues another process holds right now (see its own comment).
  await repoStep(scope, 'sweeps', async () => {
    await finishClosedIssues().catch((error) => log.error('no se pudieron cerrar los issues ya mergeados', error));
    await sweepPreviews().catch((error) => log.error('previews: no se pudieron barrer las de PRs cerrados', error));
    try {
      const open = await listAllOpenRoninPrs();
      await sweepOrphanedWorktrees(open);
      await pruneFailureSignatures(open.map((pr) => pr.number));
    } catch (error) {
      log.error('worktrees: no se pudieron barrer los de PRs cerrados', error);
    }
  });
  // Before the flows, so a merge doesn't wait behind a long review run.
  await repoStep(scope, 'auto-merge', () => sweepAutoMerge().catch((error) => log.error('auto-merge: no se pudieron revisar los PRs con el label', error)));

  // What this run's jobs are narrowed to — the event's resources, plus any
  // issue its assignment just started.
  const resources = scope ? [...scope.resources, ...justStarted.map((issue) => issueResource(issue.number))] : null;
  let inProgress: TrackingIssue[] = [];
  let allPrs: PullRequestStatus[] | null = null;
  try {
    if (runs('issues') || runs('idle-commands')) {
      inProgress = await listTrackingIssues('in-progress');
      // Merge in whatever this same run just moved to in-progress — GitHub's
      // issue-list-by-label query can lag a few seconds behind a label applied
      // moments earlier by discoverAssignedSpecs/discoverAssignedIssues above,
      // so a freshly-assigned issue could otherwise sit unstarted until the
      // *next* tick noticed it. See both functions' own doc comments.
      for (const issue of justStarted) {
        if (!inProgress.some((i) => i.number === issue.number)) inProgress.push(issue);
      }
      if (!scope) {
        inProgress = await cycleFirst(inProgress);
        log.info(`${inProgress.length} issue(s) en progreso`);
      }
      // One batched read for every issue's stack instead of a `gh pr list` +
      // a `gh pr view` per PR per issue — see
      // docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. Without
      // it no issue job is built: that failure is shared by every issue (not
      // attributable to any one of them), so it gets the same treatment as
      // ClaudeUsageLimitError: log and retry next run, never escalate.
      try {
        allPrs = await listAllOpenRoninPrs();
      } catch (error) {
        log.info(`listAllOpenRoninPrs falló, reintentando en la próxima corrida: ${(error as Error).message}`);
      }
    }
    // Only starts a separate process (see exploration/schedule.ts), so it
    // never holds this tick up; a failure here is logged, never escalated.
    await repoStep(scope, 'nightly', () => maybeLaunchNightlyExploration().catch((error) => log.error('exploración nocturna: no se pudo lanzar', error)));

    // Every flow's discovery at once, then all of their work in one pool:
    // a long external review no longer holds back an issue's quick fix, a
    // /spike or a changelog entry, and nothing waits for a whole other flow
    // to finish first. The flows share nothing, and each discovery handles
    // its own failure — one of them failing only leaves its own jobs out.
    const prs = resources ? numbersOf(resources, 'pr') : undefined;
    const issues = resources ? numbersOf(resources, 'issue') : undefined;
    const discovered = await Promise.all([
      runs('issues') && allPrs ? issueJobs(inProgress, allPrs) : [],
      runs('idle-commands') && allPrs ? idleCommandJobs(allPrs, inProgress) : [],
      // Only ever in an event's scope: a command on a PR, straight to it.
      runs('pr-commands') && prs ? prs.map((pr) => commandJob(pr)) : [],
      runs('review') ? externalReviewJobs(prs) : [],
      runs('issue-commands') ? spikeJobs(issues) : [],
      runs('changelog') ? changelogJobs() : [],
      runs('exploration') ? explorationPrJobs() : [],
    ]);
    const jobs = discovered.flat().filter((job) => !resources || job.resources.some((r) => resources.includes(r)));
    await runJobs(jobs.map(guarded), config.tickConcurrency, JOB_CAPS);
  } finally {
    // Always emitted, even when a discovery failed — durationMs vs.
    // agentRunsDurationMs is what tells whether a tick was mostly spent
    // waiting on sequential `claude -p` runs (an argument for parallelizing
    // them) or on something else entirely.
    const { agentRuns, agentRunsDurationMs } = getTickAgentMetrics();
    log.metric(scope ? 'event_complete' : 'tick_complete', { durationMs: Date.now() - start, issuesInProgress: inProgress.length, agentRuns, agentRunsDurationMs, repo: activeRepo().productRepo });
  }
}

// Entry point invoked once per cron run (see index.ts): the reconciliation
// pass, over every flow and everything in them — it picks up whatever no
// event handler did (a webhook that never arrived, a runner that was down)
// and the periodic work no event starts (sweeps, nightly exploration).
// Repos run strictly in sequence — see
// docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md §3/§5 for
// why a mutable activeRepo() singleton is safe under that constraint. A repo
// whose tick throws is logged and skipped for this run; it never stops the
// rest of repos.json from ticking.
export async function tick(): Promise<void> {
  const repos = await loadRepos();
  for (const repo of repos) {
    try {
      await withActiveRepo(repo, () => tickOneRepo());
    } catch (error) {
      log.error(`tick: ${repo.productRepo} falló, sigue con el resto: ${(error as Error).message}`);
    }
  }
}

// One event's run, in its own process (server/api/webhooks/handler.ts) inside
// withActiveRepo. Takes every resource of the scope first, waiting for
// whoever holds them, so everything it reads after is fresh. `onPinned`
// runs once it has them, before reading anything.
export async function runScoped(scope: Scope, onPinned: () => Promise<void> = async () => {}): Promise<void> {
  await pinResources(scope.resources);
  try {
    await onPinned();
    await tickOneRepo(scope);
  } finally {
    await unpinResources();
  }
}
