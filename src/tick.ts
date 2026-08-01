import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  listAssignedBugIssues,
  addIssueLabel,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  listAllOpenValeriaPrs,
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
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged, seedSingleSlice, getSlices } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask, type AgentTask } from './agent-task.js';
import { ClaudeUsageLimitError } from './claude-runner.js';
import { toStackedPrs, pickBottomPr, prsForIssue, type StackedPr } from './stack.js';
import { incrementChecksPendingCount, resetChecksPendingCount } from './local-state.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor, isBehind, attemptRebase, removeWorktree } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { findUnprocessedMentions } from './mentions.js';
import { config, LABEL_BUG, LABEL_MANAGED } from './config.js';
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

// A bug issue (bugfix label — see docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md)
// and a spec's tracking issue share the exact same slice-checklist
// machinery; this is the one place that decides which agent prompt a given
// slice actually needs. Exported for direct unit testing.
export function agentTaskFor(issue: TrackingIssue, sliceIndex: number, sliceTitle: string): AgentTask {
  return issue.labels.includes(LABEL_BUG)
    ? { type: 'fix-bug', issueNumber: issue.number, sliceIndex, sliceTitle }
    : { type: 'implement-slice', issueNumber: issue.number, sliceIndex, sliceTitle };
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

function issueUrl(issueNumber: number): string {
  return `https://github.com/${config.productRepo}/issues/${issueNumber}`;
}

// Discovery source: a human labels an existing bug-report issue (already
// carrying bmedical's own `bugfix` label) with this runner's assignment
// label — same "andá" signal as a spec PR's runner label, but without a
// draft/ready step, since a GitHub issue has no draft state. Unlike specs,
// no mirror tracking issue is created: the bug issue itself becomes the
// tracked unit, seeded with a single-slice checklist so the rest of the
// pipeline (merge gate, fix-review/fix-e2e cycles, evidence) treats it
// exactly like a spec's tracking issue. See
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
export async function discoverAssignedBugs(): Promise<void> {
  const bugs = await listAssignedBugIssues(runnerLabel());
  for (const bug of bugs) {
    try {
      // Added first, before anything else can fail, so a partial failure
      // still leaves the issue valeria-managed (and therefore reachable via
      // listTrackingIssues once set to blocked below) instead of retried
      // forever as "not yet picked up".
      await addIssueLabel(bug.number, LABEL_MANAGED);
      await seedSingleSlice(bug.number, `Fix — ${bug.title}`);
      await setIssueState(bug.number, 'in-progress');
    } catch (error) {
      await notifyBlocker({
        issueUrl: issueUrl(bug.number),
        reason: `Excepción no manejada procesando el issue de bug: ${(error as Error).message}`,
      });
      await setIssueState(bug.number, 'blocked').catch(() => {});
    }
  }
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
    // mergePullRequest retargets any dependent PR onto its own base itself
    // (a manual PATCH — GitHub does not do this automatically, see the note
    // there) before the merged branch goes away. If this PR's base still
    // isn't the root branch, that retarget never ran (e.g. a human merged
    // the predecessor from the GitHub UI, bypassing mergePullRequest
    // entirely) and this PR's base is still pointing at a now-dead branch —
    // merging it would silently land it there instead of main. Never merge
    // in that case; retry silently, then escalate like any other "needs a
    // human eventually" case. See final review Fix 1.
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.rebaseRetryLimit,
      `Base del PR del fondo del stack es "${pr.baseRefName}", no "${rootBranchName()}" — el retarget automático nunca corrió`,
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

export async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean, waitingTurnPrs?: number[]): Promise<boolean> {
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

      // Nested in its own try, separate from the outer one below: a
      // publish/comment failure here (e.g. a non-fast-forward push race on
      // ValerIA's own main, which also takes code commits — see
      // docs/DESIGN.md §4) must never prevent the reactions loop from
      // running, since a missing reaction is what makes
      // findUnprocessedMentions treat these same comments as unprocessed and
      // re-trigger the whole (expensive, side-effecting) review-request task
      // on the next tick.
      try {
        // Barato cuando no hay .png nuevos (un readdir vacío) — el supervisor
        // no interpreta el texto del mention, solo intenta publicar lo que
        // haya quedado en test-results/ tras el review-request. Sin el gate
        // de hasEvidenceComment: cada corrida disparada por mención postea su
        // propio comentario, reutilizando el mismo EVIDENCE_COMMENT_MARKER
        // que el path automático de arriba — así, la primera publicación
        // disparada por mención también deja satisfecho permanentemente el
        // hasEvidenceComment del path automático (inofensivo en la práctica:
        // ese path solo necesitaba dispararse una vez, y su ventana ya suele
        // haber pasado para cuando llega una mención, pero vale dejarlo
        // anotado). Ver docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
        const evidencePaths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
        if (evidencePaths.length > 0) {
          await postEvidenceComment(pr.number, evidencePaths.map(rawEvidenceUrl));
        }
      } catch (error) {
        log.error(`evidence publish after review-request failed for PR #${pr.number}`, error);
      }

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
      // Merged branch's worktree (and any Docker Compose stack it spun up,
      // e.g. a per-slice Postgres for integration tests) has no further use
      // once its PR is merged — see worktree.ts's removeWorktree. Best-effort:
      // never lets a leftover worktree/container block the rest of this tick.
      await removeWorktree(pr.headRefName);
      // Closes a one-tick gap: a bug-fix PR's "Closes #N" (see
      // docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md) makes
      // GitHub close the issue on merge, and listTrackingIssues filters
      // --state open — without this, the next tick would never see the
      // issue again to notice no slices remain, leaving it
      // valeria:in-progress forever. Also shaves a tick off `done` for
      // ordinary specs, harmlessly.
      if (!(await hasRemainingSlices(issue.number))) await setIssueState(issue.number, 'done');
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

// A slice ready to start, deferred rather than run immediately — see the
// two-pass split in tick() below.
interface DeferredSliceStart {
  issue: TrackingIssue;
  index: number;
  title: string;
  // Only for the log line's wording — how many open PRs this issue's stack
  // already has (0 for the very first slice).
  stackSize: number;
}

async function processIssue(issue: TrackingIssue, allPrs: PullRequestStatus[]): Promise<DeferredSliceStart | null> {
  const stack = toStackedPrs(prsForIssue(allPrs, issue.number));

  if (stack.length === 0) {
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      return { issue, index: slice.index, title: slice.title, stackSize: 0 };
    }
    // Checklist vacío del todo (nunca se sembró): el `plan` de un spec, o el
    // seedSingleSlice de un bug (ver discoverAssignedBugs), falló a mitad de
    // camino y dejó el issue con el label `valeria` puesto pero sin ninguna
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
async function runIssueStep(issue: TrackingIssue, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    // A monthly spend/usage cap is transient and resolves on its own —
    // skip this issue for this tick instead of blocking it on a human;
    // quota comes back and a later tick picks up where this left off.
    if (error instanceof ClaudeUsageLimitError) {
      log.info(`issue #${issue.number}: límite de uso de Claude alcanzado, reintentando en un tick posterior`);
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

export async function tick(): Promise<void> {
  log.info(`tick start (commit ${await currentCommit()})`);
  await discoverAssignedSpecs();
  await discoverAssignedBugs();

  const inProgress = await listTrackingIssues('in-progress');
  log.info(`${inProgress.length} issue(s) en progreso`);

  // One batched read for every issue's stack instead of a `gh pr list` + a
  // `gh pr view` per PR per issue — see
  // docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. A failure
  // here is shared across every issue in this tick (not attributable to any
  // one of them), so it gets the same treatment as ClaudeUsageLimitError:
  // log and retry next tick, never escalate to a human over it.
  let allPrs: PullRequestStatus[];
  try {
    allPrs = await listAllOpenValeriaPrs();
  } catch (error) {
    log.info(`tick: listAllOpenValeriaPrs falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return;
  }

  // Two passes, not one per issue: an implement-slice/fix-bug run can take
  // up to AGENT_TASK_TIMEOUT_MINUTES, and starting one for issue A must
  // never delay a rebase/e2e/review fix that issue B needs right now — both
  // would otherwise share this same single-flight tick (see run-tick.sh's
  // flock). So every issue's fix work (rebase, e2e, review, merge) runs
  // first, across the whole batch; only once that's done for everyone does
  // any new (potentially long) slice actually start.
  const deferred: DeferredSliceStart[] = [];
  for (const issue of inProgress) {
    if (!(await tryClaim(issue.number))) continue; // another runner already owns this one
    await runIssueStep(issue, async () => {
      const next = await processIssue(issue, allPrs);
      if (next) deferred.push(next);
    });
  }

  for (const next of deferred) {
    await runIssueStep(next.issue, async () => {
      const context = next.stackSize === 0
        ? 'sin PRs abiertos'
        : `stack de ${next.stackSize} PR(s) abierto(s)`;
      const suffix = next.stackSize === 0 ? '' : ' en paralelo';
      log.info(`issue #${next.issue.number}: ${context}, arrancando slice ${next.index + 1} (${next.title})${suffix}`);
      await runAgentTask(agentTaskFor(next.issue, next.index, next.title));
    });
  }
}
