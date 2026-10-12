import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeRepo } from './repo-context.js';
import { config } from './config.js';
import { log } from './logger.js';
import { dayIn } from './timezone.js';
import { runAgentTask, type FindingFeedback } from './agent-task.js';
import {
  addReaction,
  createIssue,
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
  batchOfBranch,
  commitAndPush,
  currentBatch,
  ensureBatchWorktree,
  explorationBranch,
  EXPLORATION_BRANCH_PREFIX,
  openFindingIssues,
  reconcileApproved,
  upsertExplorationPr,
} from './exploration-pr.js';
import { replaceProposal } from './exploration-output.js';
import { redoAfterImages } from './exploration-redo.js';
import { mentionsHandle } from './mentions.js';

// Exploration's moving parts glued to GitHub — docs/DESIGN.md §11.7:
// - exploreAndPublish: one run of one app, committed to the open
//   exploration PR's branch (or a new one), with that PR opened or
//   refreshed, and an issue right away for every bug of the app.
// - explorationPrJobs: what each tick does with the open exploration PR —
//   apply the reviewers' comments on findings (reject, edit, redo an after
//   image, open a follow-up issue), merge it once approved and open the
//   issues of its findings.
// - the worker: a run can take an hour, so it never runs inside a tick
//   (ticks are single-flight: everything else would wait). The tick starts
//   it as a separate process with its own lock — see launchExploreWorker.

export interface PublishedRun {
  summary: RunSummary;
  prNumber: number;
  batch: string;
  urgentIssues: Array<{ id: string; issue: number }>;
}

// Today in the exploration's zone (EXPLORE_TIMEZONE): the date of a run, and
// the name of the batch a new PR starts.
export function explorationDay(now: Date): string {
  return dayIn(now, config.exploreTimezone);
}

export async function exploreAndPublish(opts: {
  appName: string;
  maxFunctions?: number;
  shouldContinue?: () => boolean | Promise<boolean>;
  now?: Date;
}): Promise<PublishedRun> {
  const today = explorationDay(opts.now ?? new Date());
  const { batch } = await currentBatch(today);
  const branch = explorationBranch(batch);
  const batchDir = await ensureBatchWorktree(batch);
  const codeDir = await ensureAppWorktree(opts.appName);
  const memoryDir = memoryDirFor(batchDir, opts.appName);

  await reconcileApproved(opts.appName, memoryDir, batchDir).catch((error) => log.error('exploración: no se pudo reconciliar lo aprobado', error));
  const summary = await runExploration({
    appName: opts.appName,
    codeDir,
    memoryDir,
    today,
    ...(opts.maxFunctions ? { maxFunctions: opts.maxFunctions } : {}),
    ...(opts.shouldContinue ? { shouldContinue: opts.shouldContinue } : {}),
  });

  // A bug of the app doesn't wait for the review (§11.7, point 5); one of
  // the dev environment does.
  const newIds = new Set(summary.findings.map((f) => f.id));
  const urgentIssues = await openFindingIssues(opts.appName, memoryDir, batchDir, branch, (f) => newIds.has(f.id) && f.gravedad === 'bug' && !f.entorno);

  await commitAndPush(batchDir, branch, `exploración ${opts.appName}: corrida ${summary.runId} (${summary.findings.length} propuesta(s))`);
  const prNumber = await upsertExplorationPr(batch, batchDir);
  return { summary, prNumber, batch, urgentIssues };
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
  lines.push('', `Están en el PR de exploración: #${run.prNumber}. Revisalas ahí.`);
  return lines.join('\n');
}

// --- exploration PR maintenance, run from the tick ---

const FINDING_PATH_RE = new RegExp(`^${EXPLORATION_DIR}/([^/]+)/findings/(F-\\d+)[^/]*\\.md$`);

interface PendingFeedback {
  commentId: number;
  app: string;
  findingId: string;
  body: string;
  conversacion: NonNullable<FindingFeedback['conversacion']>;
}

// A new comment on a finding file is feedback; inside a thread, a reply is
// only when it mentions ronin — people also talk among themselves there.
async function pendingFeedback(pr: PullRequestStatus): Promise<PendingFeedback[]> {
  const comments = await listFileReviewComments(pr.number);
  const isBot = (login: string) => login.toLowerCase() === config.githubLogin.toLowerCase();
  const rootOf = (c: { id: number; inReplyToId?: number }) => c.inReplyToId ?? c.id;
  const findingOf = (path: string) => path.match(FINDING_PATH_RE);
  const result: PendingFeedback[] = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin) continue;
    if (c.inReplyToId && !mentionsHandle(c.body, config.githubLogin)) continue;
    const match = findingOf(c.path);
    if (!match) continue;
    if (c.reactionsEyes > 0 && (await hasBotReaction(c.id, 'review', config.githubLogin))) continue;
    // Matched by app and id, not path: an edited title renames the file.
    const conversacion = comments
      .filter((o) => o.id < c.id && findingOf(o.path)?.[1] === match[1] && findingOf(o.path)?.[2] === match[2])
      .sort((a, b) => a.id - b.id)
      .map((o) => ({ autor: isBot(o.authorLogin) ? ('ronin' as const) : ('persona' as const), texto: o.body, mismoHilo: rootOf(o) === rootOf(c) }));
    result.push({ commentId: c.id, app: match[1], findingId: match[2], body: c.body, conversacion });
  }
  return result;
}

export interface RedoItem {
  app: string;
  findingId: string;
  instruction: string;
  commentId: number;
}

interface FeedbackAction {
  commentId: number;
  accion: string;
  motivo?: string;
  titulo?: string;
  propuesta?: string;
  rehacerDespues?: string;
  issue?: { titulo?: string; cuerpo?: string };
  respuesta?: string;
}

function clean(text: string): string {
  return text.replace(/@(?=\w)/g, '');
}

// Applies what each new comment on a finding asks for — the agent only
// classifies it, the changes are made here: reject (finding + knowledge),
// edit (title, proposal), open a follow-up issue. Redoing an after image
// needs the app running, so those come back for the worker.
async function applyFeedback(pr: PullRequestStatus, batch: string): Promise<RedoItem[]> {
  const pending = await pendingFeedback(pr);
  if (pending.length === 0) return [];
  const batchDir = await ensureBatchWorktree(batch);
  const comments: FindingFeedback[] = [];
  for (const p of pending) {
    const memory = await loadMemory(memoryDirFor(batchDir, p.app));
    const meta = memory.findings.find((f) => f.id === p.findingId);
    comments.push({ commentId: p.commentId, findingId: p.findingId, titulo: meta?.titulo ?? p.findingId, body: p.body, conversacion: p.conversacion });
  }
  await mkdir(explorationOutDir(), { recursive: true });
  const outputPath = join(explorationOutDir(), `feedback-${pr.number}.json`);
  await rm(outputPath, { force: true });
  await runAgentTask({ type: 'explore-feedback', prNumber: pr.number, checkoutDir: batchDir, comments, outputPath });
  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as { acciones?: FeedbackAction[] };

  const replies: Array<{ commentId: number; body: string }> = [];
  const redo: RedoItem[] = [];
  for (const p of pending) {
    const action = parsed.acciones?.find((a) => a.commentId === p.commentId);
    if (!action) continue;
    const memoryDir = memoryDirFor(batchDir, p.app);
    const meta = (await loadMemory(memoryDir)).findings.find((f) => f.id === p.findingId);
    const path = meta ? join(memoryDir, 'findings', findingFileName(meta)) : undefined;
    let reply = action.respuesta ? clean(action.respuesta) : '';
    if (action.accion === 'rechazar' && action.motivo && path) {
      const finding = parseFinding(await readFile(path, 'utf8'));
      const motivo = action.motivo.trim().slice(0, 300);
      await writeFile(path, serializeFinding({ ...finding, estado: 'rechazado', motivo }));
      await appendKnowledge(memoryDir, `${motivo} (${p.findingId}, rechazada en #${pr.number})`);
    } else if (action.accion === 'editar' && path) {
      const finding = parseFinding(await readFile(path, 'utf8'));
      const titulo = action.titulo?.trim() ? action.titulo.trim().slice(0, 120) : finding.titulo;
      let body = action.propuesta?.trim() ? replaceProposal(finding.body, action.propuesta.slice(0, 1600)) : finding.body;
      if (titulo !== finding.titulo) body = body.replace(/^## .*$/m, `## ${titulo}`);
      // The file name follows the title: a new title moves the file.
      await rm(path, { force: true });
      await writeFile(join(memoryDir, 'findings', findingFileName({ id: finding.id, titulo })), serializeFinding({ ...finding, titulo, body }));
      if (action.rehacerDespues?.trim()) redo.push({ app: p.app, findingId: p.findingId, instruction: action.rehacerDespues.trim().slice(0, 1200), commentId: p.commentId });
    } else if (action.accion === 'crear-issue' && action.issue?.titulo?.trim()) {
      const ref = `Pedido en un comentario sobre la ficha ${p.findingId} del PR de exploración #${pr.number}.`;
      const created = await createIssue(clean(action.issue.titulo.trim()).slice(0, 200), `${clean(action.issue.cuerpo?.trim() ?? '')}\n\n${ref}`, []).catch((error) => {
        log.error(`exploración: no se pudo crear el issue pedido en el comentario ${p.commentId}`, error);
        return undefined;
      });
      reply = created ? `${reply}\n\nAbrí #${created.number}.`.trim() : `${reply}\n\nNo pude abrir el issue; el detalle está en el log del runner.`.trim();
    }
    if (reply) replies.push({ commentId: p.commentId, body: reply });
  }
  if (await commitAndPush(batchDir, explorationBranch(batch), `exploración: feedback del PR #${pr.number}`)) await upsertExplorationPr(batch, batchDir);
  for (const r of replies) await replyToComment(pr.number, { id: r.commentId, kind: 'review' }, r.body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${r.commentId}`, error));
  for (const p of pending) await addReaction(p.commentId, 'review', 'eyes').catch(() => {});
  return redo;
}

async function mergeAndOpenIssues(pr: PullRequestStatus, batch: string): Promise<void> {
  const batchDir = await ensureBatchWorktree(batch);
  await mergePullRequest(pr.number);
  log.info(`exploración: PR #${pr.number} mergeado, abriendo issues de sus propuestas`);
  const base = (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
  for (const app of await appsWithMemory(batchDir)) {
    await openFindingIssues(app, memoryDirFor(batchDir, app), batchDir, base, (f) => f.estado === 'propuesto');
  }
}

export async function processExplorationPr(pr: PullRequestStatus): Promise<void> {
  const batch = batchOfBranch(pr.headRefName);
  if (!batch) return;
  if (await exploreWorkerBusy()) return; // the worker is writing this branch right now
  const redo = await applyFeedback(pr, batch);
  if (redo.length > 0) {
    launchExploreWorker({ repo: activeRepo().productRepo, appName: redo[0].app, redo: { prNumber: pr.number, batch, items: redo } });
    return; // the worker now owns the branch; merging waits for the next tick
  }
  // PRs opened as drafts before batches were rolling.
  if (pr.isDraft) {
    await markPullRequestReady(pr.number);
    log.info(`exploración: PR #${pr.number} listo para revisar`);
    return;
  }
  if (pr.reviewDecision === 'APPROVED') await mergeAndOpenIssues(pr, batch);
}

// The redo half of the feedback, in the worker: new after images for the
// findings a reviewer asked to fix, committed to the PR, and a reply on
// each comment.
export async function redoAndPublish(redo: NonNullable<ExploreWorkerRequest['redo']>): Promise<void> {
  const batchDir = await ensureBatchWorktree(redo.batch);
  const done = new Set<string>();
  for (const app of [...new Set(redo.items.map((i) => i.app))]) {
    const items = redo.items.filter((i) => i.app === app);
    const codeDir = await ensureAppWorktree(app);
    for (const id of await redoAfterImages({ appName: app, codeDir, memoryDir: memoryDirFor(batchDir, app), requests: items })) done.add(`${app}/${id}`);
  }
  if (await commitAndPush(batchDir, explorationBranch(redo.batch), `exploración: después rehecho (${[...done].join(', ') || 'ninguno'})`)) await upsertExplorationPr(redo.batch, batchDir);
  for (const item of redo.items) {
    const ok = done.has(`${item.app}/${item.findingId}`);
    const body = ok
      ? `Rehice la imagen del después de ${item.findingId}; ya está en la ficha.`
      : `No pude rehacer la imagen del después de ${item.findingId}; el detalle está en el log del runner.`;
    await replyToComment(redo.prNumber, { id: item.commentId, kind: 'review' }, body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${item.commentId}`, error));
  }
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
  // Instead of a run: redo the after images reviewers asked for.
  redo?: { prNumber: number; batch: string; items: RedoItem[] };
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
