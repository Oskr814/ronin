import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  getOpenPrsForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  addReaction,
  getPullRequestStatus,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './spec-content.js';
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask } from './agent-task.js';
import { ClaudeUsageLimitError } from './claude-runner.js';
import { toStackedPrs, pickBottomPr, type StackedPr } from './stack.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor, isBehind, attemptRebase } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { findUnprocessedMentions } from './mentions.js';
import { config } from './config.js';
import { log } from './logger.js';
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
  return `https://github.com/${config.productRepo}/pull/${prNumber}`;
}

async function renderTrackingIssueBody(specPaths: string[]): Promise<string> {
  const template = await readFile(join(process.cwd(), 'templates/tracking-issue.md'), 'utf8');
  const repoUrl = `https://github.com/${config.productRepo}`;
  const specLinks = specPaths.map((p) => `- [${p}](${repoUrl}/blob/main/${p})`).join('\n');
  return template.replaceAll('{{spec_links}}', specLinks);
}

// Prefers a file under a `specs/` subdirectory as the "primary" doc (title,
// issue naming) when a spec PR includes several .md files (e.g. bmedical's
// own convention pairs a specs/<name>-design.md with plans/<name>.md) —
// falls back to the first file if nothing matches that shape.
function primarySpecPath(specPaths: string[]): string {
  return specPaths.find((p) => p.includes('/specs/')) ?? specPaths[0];
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
      // Without this, the issue stays labeled valeria:ready forever and
      // listTrackingIssues('in-progress') would never find it again.
      await setIssueState(issue.number, 'in-progress');
      await tryClaim(issue.number);
      await setPrState(pr.number, 'done');
      // The spec PR itself is merged and mostly done at this point — this
      // is the one place a human watching that PR (not the tracking issue)
      // finds out where the actual work moved to.
      await commentOnSpecPr(pr.number, `🚀 Started: tracked in ${issue.url}`);
      // The plan task rewrites the issue body with the real slice checklist.
      await runAgentTask({ type: 'plan', issueNumber: issue.number, specPaths });
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

// 'ready': at or already merged onto worktreeBaseRef, safe to evaluate merge
// this tick. 'not-ready': nothing wrong, just nothing more to do for this PR
// this tick (worktree dir missing so far — retried silently up to
// rebaseRetryLimit ticks in case it's transient, e.g. a runner mid-restart —
// or a rebase+force-push just happened and its CI hasn't run against the new
// head yet; either way the next tick re-reads PR status fresh and evaluates
// merge then, per docs/superpowers/specs/2026-07-28-stacked-prs-design.md
// §5). 'blocked': the issue was just set to valeria:blocked by
// blockOnAttemptLimit.
type BottomStatus = 'ready' | 'not-ready' | 'blocked';

// Bare branch name a bottom-of-stack PR's base should point at, e.g.
// "origin/main" -> "main" — this codebase always uses "origin" as the
// remote name elsewhere too (see worktree.ts).
function rootBranchName(): string {
  return config.worktreeBaseRef.replace(/^origin\//, '');
}

async function ensureBottomUpToDate(issue: TrackingIssue, pr: StackedPr): Promise<BottomStatus> {
  if (pr.baseRefName !== rootBranchName()) {
    // GitHub auto-retargets the bottom PR's base to the root branch when its
    // predecessor merges via mergePullRequest's --delete-branch. If that
    // never fired (e.g. a human merged the predecessor from the GitHub UI
    // without deleting its branch), this PR's base is still pointing at a
    // now-dead branch — merging it would silently land it there instead of
    // main. Never merge in that case; retry silently, then escalate like any
    // other "needs a human eventually" case. See final review Fix 1.
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.rebaseRetryLimit,
      `Base del PR del fondo del stack es "${pr.baseRefName}", no "${rootBranchName()}" — el auto-retarget de GitHub no ocurrió`,
    );
    return blocked ? 'blocked' : 'not-ready';
  }

  const worktreeDir = worktreeDirFor(pr.headRefName);
  if (!existsSync(worktreeDir)) {
    // Still deliberately NOT auto-recreated via ensureWorktree here, even
    // though the root cause that originally justified this (branchExists
    // only checking local refs, never origin/<branch>) was fixed by adding
    // remoteBranchExists to worktree.ts (final review Fix 2) — re-wiring
    // this call site wasn't part of that fix's scope, so it's left as-is:
    // treated as a mechanical failure like a rebase conflict, retried
    // silently via the same attempt counter, then escalated to a real
    // human-visible block — never a silent-forever stall, never fabricated
    // git state.
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.rebaseRetryLimit,
      'Worktree del fondo del stack no encontrado en disco tras el límite de reintentos',
    );
    return blocked ? 'blocked' : 'not-ready';
  }
  if (!(await isBehind(worktreeDir, config.worktreeBaseRef))) return 'ready';
  if (await attemptRebase(worktreeDir, config.worktreeBaseRef, pr.headRefName)) return 'not-ready';

  const blocked = await blockOnAttemptLimit(
    issue, pr, config.rebaseRetryLimit,
    'Rebase con conflicto real tras el límite de reintentos',
  );
  if (blocked) return 'blocked';
  await runAgentTask({ type: 'fix-rebase', issueNumber: issue.number, prNumber: pr.number });
  return 'not-ready';
}

// Returns whether the issue is still in-progress: false means this PR just
// triggered blockOnAttemptLimit (issue set to valeria:blocked) and the caller
// must stop processing the rest of the stack and skip starting new work.
function logSliceOutcome(issue: TrackingIssue, pr: StackedPr, isBottom: boolean, outcome: string): void {
  log.info(`issue #${issue.number} slice ${pr.sliceIndex + 1} PR #${pr.number}${isBottom ? ' (bottom)' : ''}: ${outcome}`);
}

export async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean): Promise<boolean> {
  await recordSlicePr(issue.number, pr.sliceIndex, pr.number);

  // Checked every tick until it succeeds once (hasEvidenceComment gates the
  // repeat work) — ver docs/DESIGN.md §4.
  if (!(await hasEvidenceComment(pr.number))) {
    const paths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
    if (paths.length > 0) {
      await postEvidenceComment(pr.number, paths.map(rawEvidenceUrl));
    }
  }

  if (pr.isDraft) {
    logSliceOutcome(issue, pr, isBottom, 'draft, esperando');
    return true;
  }

  // The detection call itself is inside the try on purpose: a transient API
  // failure reading comments must stay local to this secondary flow, never
  // reach tick()'s catch and put the whole issue in `blocked` (which also
  // emails a human). See docs/superpowers/specs/2026-07-28-mention-review-design.md.
  try {
    const mentions = await findUnprocessedMentions(pr.number);
    if (mentions.length > 0) {
      await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });
      for (const m of mentions) await addReaction(m.id, m.kind, 'eyes');
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
    // that doesn't land shouldn't block the slice loop. No reaction was
    // added, so the next tick picks these same comments up again.
    log.error(`review-request failed for PR #${pr.number}`, error);
  }

  // Solo el fondo del stack necesita estar al día con main antes de evaluar
  // merge — ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md §5.
  if (isBottom) {
    const status = await ensureBottomUpToDate(issue, pr);
    if (status === 'blocked') return false;
    if (status === 'not-ready') {
      logSliceOutcome(issue, pr, isBottom, 'poniéndose al día con main, esperando');
      return true;
    }

    if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
      await mergePullRequest(pr.number);
      await markSliceMerged(issue.number, pr.sliceIndex);
      logSliceOutcome(issue, pr, isBottom, 'mergeado');
      return true;
    }
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
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
    logSliceOutcome(issue, pr, isBottom, 'esperando su turno (no es el fondo)');
    return true;
  }

  // CI still running (queued/in-progress) reads the same as checksPassing
  // === false — wait for it instead of treating it as an actual failure, so
  // in-flight checks don't trigger a spurious fix-e2e / attempt increment.
  // See final review Fix 6. Bounded by the same attempt limit as the actual
  // e2e-failure path below (and sharing its counter) so a rollup that never
  // reports anything — e.g. a path-filtered workflow that never triggers for
  // this slice — still escalates instead of waiting forever in silence.
  if (pr.checksPending) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'CI nunca reportó resultados tras el límite de reintentos',
    );
    if (!blocked) logSliceOutcome(issue, pr, isBottom, 'checks pendientes, esperando');
    return !blocked;
  }

  if (!pr.checksPassing) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'E2E fallando persistentemente tras el límite de reintentos',
    );
    if (blocked) return false;
    logSliceOutcome(issue, pr, isBottom, 'checks fallando, disparando fix-e2e');
    await runAgentTask({ type: 'fix-e2e', issueNumber: issue.number, prNumber: pr.number });
    return true;
  }

  // Checks passing, no changes requested, not yet approved: normal
  // waiting-for-review state per docs/BLOCKING.md — no action, no notification.
  logSliceOutcome(issue, pr, isBottom, 'checks OK, esperando review');
  return true;
}

async function processIssue(issue: TrackingIssue): Promise<void> {
  const stack = toStackedPrs(await getOpenPrsForIssue(issue.number));

  if (stack.length === 0) {
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      log.info(`issue #${issue.number}: sin PRs abiertos, arrancando slice ${slice.index + 1} (${slice.title})`);
      await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: slice.index, sliceTitle: slice.title });
      return;
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
      return;
    }
    log.info(`issue #${issue.number}: todas las slices mergeadas, done`);
    await setIssueState(issue.number, 'done');
    return;
  }

  const bottom = pickBottomPr(stack)!; // stack.length >= 1 acá, chequeado arriba
  for (const pr of stack) {
    const stillInProgress = await processSlicePr(issue, pr, pr.sliceIndex === bottom.sliceIndex);
    if (!stillInProgress) return; // se acaba de bloquear el issue — no arrancar trabajo nuevo
  }

  const nextUnstarted = await nextUnstartedSlice(issue.number);
  if (nextUnstarted) {
    log.info(`issue #${issue.number}: stack de ${stack.length} PR(s) abierto(s), arrancando slice ${nextUnstarted.index + 1} (${nextUnstarted.title}) en paralelo`);
    await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: nextUnstarted.index, sliceTitle: nextUnstarted.title });
  }
}

export async function tick(): Promise<void> {
  log.info(`tick start (commit ${await currentCommit()})`);
  await discoverAssignedSpecs();

  const inProgress = await listTrackingIssues('in-progress');
  log.info(`${inProgress.length} issue(s) en progreso`);
  for (const issue of inProgress) {
    if (!(await tryClaim(issue.number))) continue; // another runner already owns this one

    try {
      await processIssue(issue);
    } catch (error) {
      // A monthly spend/usage cap is transient and resolves on its own —
      // skip this issue for this tick instead of blocking it on a human;
      // quota comes back and a later tick picks up where this left off.
      if (error instanceof ClaudeUsageLimitError) {
        log.info(`issue #${issue.number}: límite de uso de Claude alcanzado, reintentando en un tick posterior`);
      } else {
        await notifyBlocker({
          issueUrl: issue.url,
          reason: `Excepción no manejada procesando el issue: ${(error as Error).message}`,
        });
        await setIssueState(issue.number, 'blocked');
      }
    }
    await releaseIfNoLongerInProgress(issue.number);
  }
}
