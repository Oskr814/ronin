import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeRepo } from './repo-context.js';
import { config } from './config.js';
import { log } from './logger.js';
import { runAgentTask, type FindingFeedback } from './agent-task.js';
import {
  addReaction,
  listFileReviewComments,
  listOpenPrsByHeadPrefix,
  markPullRequestReady,
  mergePullRequest,
  replyToComment,
  hasBotReaction,
  type PullRequestStatus,
} from './github.js';
import { ensureAppWorktree } from './app-runtime.js';
import { appendKnowledge, EXPLORATION_DIR, findingFileName, loadMemory, memoryDirFor, parseFinding, serializeFinding } from './exploration-memory.js';
import { explorationOutDir } from './exploration-inventory.js';
import { runExploration, type RunSummary } from './exploration-run.js';
import {
  appsWithMemory,
  commitAndPush,
  ensureWeekWorktree,
  explorationBranch,
  EXPLORATION_BRANCH_PREFIX,
  isoWeek,
  openFindingIssues,
  reconcileApproved,
  upsertWeeklyPr,
  weekOfBranch,
} from './exploration-pr.js';

// Exploration's moving parts glued to GitHub — docs/DESIGN.md §11.7:
// - exploreAndPublish: one run of one app, committed to the week's branch,
//   with the weekly PR opened or refreshed, and an issue right away for
//   every bug-severity finding.
// - explorationPrJobs: what each tick does with the open weekly PRs —
//   apply the reviewers' comments on findings, mark last week's PR ready,
//   merge an approved one and open the issues of its findings.
// - the worker: a run can take an hour, so it never runs inside a tick
//   (ticks are single-flight: everything else would wait). The tick starts
//   it as a separate process with its own lock — see launchExploreWorker.

export interface PublishedRun {
  summary: RunSummary;
  prNumber: number;
  week: string;
  urgentIssues: Array<{ id: string; issue: number }>;
}

export async function exploreAndPublish(opts: {
  appName: string;
  maxFunctions?: number;
  shouldContinue?: () => boolean | Promise<boolean>;
  now?: Date;
}): Promise<PublishedRun> {
  const now = opts.now ?? new Date();
  const week = isoWeek(now);
  const branch = explorationBranch(week);
  const today = now.toISOString().slice(0, 10);
  const weekDir = await ensureWeekWorktree(week);
  const codeDir = await ensureAppWorktree(opts.appName);
  const memoryDir = memoryDirFor(weekDir, opts.appName);

  await reconcileApproved(opts.appName, memoryDir, weekDir).catch((error) => log.error('exploración: no se pudo reconciliar lo aprobado', error));
  const summary = await runExploration({
    appName: opts.appName,
    codeDir,
    memoryDir,
    today,
    ...(opts.maxFunctions ? { maxFunctions: opts.maxFunctions } : {}),
    ...(opts.shouldContinue ? { shouldContinue: opts.shouldContinue } : {}),
  });

  // A bug doesn't wait for the end of the week (§11.7, point 5).
  const newIds = new Set(summary.findings.map((f) => f.id));
  const urgentIssues = await openFindingIssues(opts.appName, memoryDir, weekDir, branch, (f) => newIds.has(f.id) && f.gravedad === 'bug');

  await commitAndPush(weekDir, branch, `exploración ${opts.appName}: corrida ${summary.runId} (${summary.findings.length} propuesta(s))`);
  const prNumber = await upsertWeeklyPr(week, weekDir);
  return { summary, prNumber, week, urgentIssues };
}

export function renderRunReply(appName: string, run: PublishedRun): string {
  const { summary } = run;
  const explored = summary.outcomes.filter((o) => o.status === 'explorada').map((o) => `\`${o.planned.functionId}\` (${o.planned.charter})`);
  const failed = summary.outcomes.filter((o) => o.status === 'fallo').map((o) => `\`${o.planned.functionId}\``);
  const lines = [
    `Exploré \`${appName}\`: ${explored.length > 0 ? explored.join(', ') : 'ninguna función'}${failed.length > 0 ? `; fallaron ${failed.join(', ')}` : ''}.`,
    '',
  ];
  if (summary.findings.length === 0) {
    lines.push(`No encontré nada que valga la pena proponer${summary.discarded.length > 0 ? ` (descarté ${summary.discarded.length} candidato(s); el detalle está en la corrida)` : ''}.`);
  } else {
    lines.push(`Propuestas (${summary.findings.length}):`, '');
    for (const f of summary.findings) {
      const issue = run.urgentIssues.find((u) => u.id === f.id);
      lines.push(`- **${f.id}** ${f.titulo} — \`${f.gravedad}\`${issue ? ` · issue #${issue.issue}` : ''}`);
    }
  }
  lines.push('', `Están en el PR de exploración de la semana: #${run.prNumber}. Revisalas ahí.`);
  return lines.join('\n');
}

// --- weekly PR maintenance, run from the tick ---

const FINDING_PATH_RE = new RegExp(`^${EXPLORATION_DIR}/([^/]+)/findings/(F-\\d+)[^/]*\\.md$`);

async function pendingFeedback(pr: PullRequestStatus): Promise<Array<{ commentId: number; app: string; findingId: string; body: string }>> {
  const comments = await listFileReviewComments(pr.number);
  const result = [];
  for (const c of comments) {
    if (c.inReplyToId || c.authorLogin.toLowerCase() === config.githubLogin.toLowerCase() || !c.authorLogin) continue;
    const match = c.path.match(FINDING_PATH_RE);
    if (!match) continue;
    if (c.reactionsEyes > 0 && (await hasBotReaction(c.id, 'review', config.githubLogin))) continue;
    result.push({ commentId: c.id, app: match[1], findingId: match[2], body: c.body });
  }
  return result;
}

async function applyFeedback(pr: PullRequestStatus, week: string): Promise<void> {
  const pending = await pendingFeedback(pr);
  if (pending.length === 0) return;
  const weekDir = await ensureWeekWorktree(week);
  const comments: FindingFeedback[] = [];
  for (const p of pending) {
    const memory = await loadMemory(memoryDirFor(weekDir, p.app));
    const meta = memory.findings.find((f) => f.id === p.findingId);
    comments.push({ commentId: p.commentId, findingId: p.findingId, titulo: meta?.titulo ?? p.findingId, body: p.body });
  }
  await mkdir(explorationOutDir(), { recursive: true });
  const outputPath = join(explorationOutDir(), `feedback-${pr.number}.json`);
  await rm(outputPath, { force: true });
  await runAgentTask({ type: 'explore-feedback', prNumber: pr.number, checkoutDir: weekDir, comments, outputPath });
  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as { acciones?: Array<{ commentId: number; accion: string; motivo?: string; respuesta?: string }> };

  const replies: Array<{ commentId: number; body: string }> = [];
  for (const p of pending) {
    const action = parsed.acciones?.find((a) => a.commentId === p.commentId);
    if (!action) continue;
    if (action.accion === 'rechazar' && action.motivo) {
      const memoryDir = memoryDirFor(weekDir, p.app);
      const meta = (await loadMemory(memoryDir)).findings.find((f) => f.id === p.findingId);
      if (meta) {
        const path = join(memoryDir, 'findings', findingFileName(meta));
        const finding = parseFinding(await readFile(path, 'utf8'));
        const motivo = action.motivo.trim().slice(0, 300);
        await writeFile(path, serializeFinding({ ...finding, estado: 'rechazado', motivo }));
        await appendKnowledge(memoryDir, `${motivo} (${p.findingId}, rechazada en #${pr.number})`);
      }
    }
    if (action.respuesta) replies.push({ commentId: p.commentId, body: action.respuesta.replace(/@(?=\w)/g, '') });
  }
  if (await commitAndPush(weekDir, explorationBranch(week), `exploración: feedback del PR #${pr.number}`)) await upsertWeeklyPr(week, weekDir);
  for (const r of replies) await replyToComment(pr.number, { id: r.commentId, kind: 'review' }, r.body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${r.commentId}`, error));
  for (const p of pending) await addReaction(p.commentId, 'review', 'eyes').catch(() => {});
}

async function mergeAndOpenIssues(pr: PullRequestStatus, week: string): Promise<void> {
  const weekDir = await ensureWeekWorktree(week);
  await mergePullRequest(pr.number);
  log.info(`exploración: PR semanal #${pr.number} mergeado, abriendo issues de sus propuestas`);
  const base = (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
  for (const app of await appsWithMemory(weekDir)) {
    await openFindingIssues(app, memoryDirFor(weekDir, app), weekDir, base, (f) => f.estado === 'propuesto');
  }
}

export async function processExplorationPr(pr: PullRequestStatus, now = new Date()): Promise<void> {
  const week = weekOfBranch(pr.headRefName);
  if (!week) return;
  if (await exploreWorkerBusy()) return; // the worker is writing this branch right now
  await applyFeedback(pr, week);
  if (pr.isDraft) {
    if (week < isoWeek(now)) {
      await markPullRequestReady(pr.number);
      log.info(`exploración: PR semanal #${pr.number} (${week}) listo para revisar`);
    }
    return;
  }
  if (pr.reviewDecision === 'APPROVED') await mergeAndOpenIssues(pr, week);
}

export async function explorationPrs(): Promise<PullRequestStatus[]> {
  return listOpenPrsByHeadPrefix(EXPLORATION_BRANCH_PREFIX);
}

// --- the worker process and its lock ---

export interface ExploreWorkerRequest {
  repo: string;
  appName: string;
  maxFunctions?: number;
  // The /explore comment that asked for it, to answer and react to.
  trigger?: { issueNumber: number; commentIds: number[] };
  // Nightly runs stop starting new functions once the window closes.
  until?: string;
}

function lockPath(): string {
  const slug = activeRepo().productRepo.replaceAll('/', '-');
  return join(activeRepo().worktreeBasePath, `.explore-${slug}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function exploreWorkerBusy(): Promise<boolean> {
  try {
    const pid = Number((await readFile(lockPath(), 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

// Exclusive create; a lock left by a dead process is taken over.
export async function acquireExploreLock(): Promise<boolean> {
  await mkdir(dirname(lockPath()), { recursive: true });
  if (existsSync(lockPath()) && !(await exploreWorkerBusy())) await rm(lockPath(), { force: true });
  try {
    const handle = await openFile(lockPath(), 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function releaseExploreLock(): Promise<void> {
  await rm(lockPath(), { force: true });
}

// Starts the worker detached from the tick: same runtime (node on dist/, or
// tsx in development), same environment. Its output goes to the same daily
// log the cron wrapper writes the tick to (scripts/setup-cron.sh), so its
// lines sit next to the tick's.
export function launchExploreWorker(request: ExploreWorkerRequest): void {
  const here = fileURLToPath(import.meta.url);
  const worker = join(dirname(here), `explore-worker${here.endsWith('.ts') ? '.ts' : '.js'}`);
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
  const out = openSync(join(process.cwd(), 'logs', `tick-${day}.log`), 'a');
  try {
    const child = spawn(process.execPath, [...process.execArgv, worker, JSON.stringify(request)], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    log.info(`exploración: worker lanzado para ${request.appName} (pid ${child.pid})`);
  } finally {
    closeSync(out);
  }
}

export async function reactToTrigger(trigger: ExploreWorkerRequest['trigger']): Promise<void> {
  if (!trigger) return;
  for (const id of trigger.commentIds) await addReaction(id, 'issue', 'eyes').catch(() => {});
}
