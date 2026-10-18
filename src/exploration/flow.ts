import { isProcessed, markProcessed } from '../core/processed-comments.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRepo } from '../core/repo-context.js';
import { acquireLock, launchWorker, lockHeld } from '../core/worker-launch.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { queueExplorationProject } from '../core/linear-assign.js';
import { dayIn } from '../core/timezone.js';
import { runAgentTask } from '../core/agent-task.js';
import { explorationTask, type FindingFeedback, type FindingSummary, type GeneralFeedback } from './prompts.js';
import {
  closeIssueNotPlanned,
  createIssue,
  listFileReviewComments,
  listIssueComments,
  listOpenPrsByHeadPrefix,
  markPullRequestReady,
  mergePullRequest,
  replyToComment,
  type PullRequestStatus,
} from '../core/github.js';
import { ensureAppWorktree } from '../app/index.js';
import { appendKnowledge, EXPLORATION_DIR, findingFileName, loadMemory, memoryDirFor, parseFinding, serializeFinding } from './memory.js';
import { explorationOutDir } from './inventory.js';
import { runExploration, type RunSummary } from './run.js';
import {
  appsWithMemory,
  approveFindings,
  batchOfBranch,
  commitAndPush,
  currentBatch,
  ensureBatchWorktree,
  explorationBranch,
  EXPLORATION_BRANCH_PREFIX,
  openFindingIssues,
  reconcileApproved,
  upsertExplorationPr,
} from './pr.js';
import { clip, LIMITS, replaceProposal } from './output.js';
import { redoAfterImages } from './redo.js';
import { mentionsHandle } from '../commands/index.js';
import type { CommitChange } from '../core/commit-style.js';

// Exploration's moving parts glued to GitHub — docs/DESIGN.md §11.7:
// - exploreAndPublish: one run of one app, committed to the open
//   exploration PR's branch (or a new one), with that PR opened or
//   refreshed, and an issue right away for every bug of the app.
// - explorationPrJobs: what each tick does with the open exploration PR —
//   apply the reviewers' comments on findings (reject, edit, redo an after
//   image, open a follow-up issue), and once approved mark its findings
//   approved, open their issues and merge it.
// - the worker: a run can take an hour, so it never runs inside a tick
//   (ticks are single-flight: everything else would wait). The tick starts
//   it as a separate process with its own lock — see launchExploreWorker.

export interface PublishedRun {
  summary: RunSummary;
  prNumber: number;
  batch: string;
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

  // No issues here, not even for a bug: a finding gets its issue only once
  // the PR is approved and it's still standing (approveAndMerge,
  // reconcileApproved), so a rejected one never leaves an issue behind.
  await commitAndPush(batchDir, branch, runCommitChange(opts.appName, summary.runId, summary.findings));
  const prNumber = await upsertExplorationPr(batch, batchDir);
  return { summary, prNumber, batch };
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
      lines.push(`- **${f.id}** ${f.titulo} — \`${f.gravedad}\``);
    }
  }
  lines.push('', `Están en el PR de exploración: #${run.prNumber}. Revisalas ahí: al aprobarlo abro un issue por cada una que siga en pie.`);
  return lines.join('\n');
}

// "F-0001, F-0002" for a few ids, "F-0001–F-0008" for many.
export function idList(ids: string[]): string {
  const sorted = [...ids].sort();
  return sorted.length <= 3 ? sorted.join(', ') : `${sorted[0]}–${sorted[sorted.length - 1]}`;
}

function joinParts(parts: string[], and: string): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${and} ${parts[parts.length - 1]}`;
}

export function runCommitChange(appName: string, runId: string, findings: Array<{ id: string; titulo: string; gravedad: string }>): CommitChange {
  const ids = findings.map((f) => f.id);
  return {
    description: findings.length > 0
      ? `An exploration run (${runId}) of the app "${appName}" adds these findings to the exploration memory:\n${findings.map((f) => `- ${f.id} [${f.gravedad}] ${f.titulo}`).join('\n')}`
      : `An exploration run (${runId}) of the app "${appName}" found nothing new; only its run record and the app's function inventory change.`,
    fallback: findings.length > 0
      ? { en: `add ${findings.length} ${appName} finding${findings.length === 1 ? '' : 's'} (${idList(ids)})`, es: `agregar ${findings.length} hallazgo${findings.length === 1 ? '' : 's'} de ${appName} (${idList(ids)})` }
      : { en: `record ${appName} run ${runId} with no new findings`, es: `registrar la corrida ${runId} de ${appName} sin hallazgos nuevos` },
  };
}

export interface FeedbackChange {
  findingId: string;
  titulo: string;
  kind: 'rechazada' | 'editada';
  detail: string;
  redo?: boolean;
}

export function feedbackCommitChange(prNumber: number, changes: FeedbackChange[], knowledge: Array<{ app: string; texto: string }> = []): CommitChange {
  const rejected = changes.filter((c) => c.kind === 'rechazada').map((c) => c.findingId);
  const edited = changes.filter((c) => c.kind === 'editada').map((c) => c.findingId);
  const apps = [...new Set(knowledge.map((k) => k.app))].sort();
  const en = [...(rejected.length ? [`reject ${idList(rejected)}`] : []), ...(edited.length ? [`update ${idList(edited)}`] : []), ...(apps.length ? [`note team decisions for ${apps.join(', ')}`] : [])];
  const es = [...(rejected.length ? [`rechazar ${idList(rejected)}`] : []), ...(edited.length ? [`corregir ${idList(edited)}`] : []), ...(apps.length ? [`anotar decisiones del equipo para ${apps.join(', ')}`] : [])];
  const lines = [
    ...changes.map((c) => `- ${c.findingId} ("${c.titulo}") ${c.kind === 'rechazada' ? 'rejected' : 'edited'}: ${c.detail}${c.redo ? ' (its after image will be redone)' : ''}`),
    ...knowledge.map((k) => `- added to the ${k.app} knowledge file, so later explorations leave it alone: ${k.texto}`),
  ];
  return {
    description: `Applies review feedback from PR #${prNumber} to the exploration memory:\n${lines.join('\n')}`,
    fallback: { en: `${joinParts(en, 'and')} from PR #${prNumber} review`, es: `${joinParts(es, 'y')} según la review del PR #${prNumber}` },
  };
}

export function approveCommitChange(prNumber: number, approved: Array<{ id: string; titulo: string }>): CommitChange {
  const ids = approved.map((a) => a.id);
  return {
    description: `PR #${prNumber} was approved: marks its findings still standing as approved and records the issue opened for each one:\n${approved.map((a) => `- ${a.id} ${a.titulo}`).join('\n')}`,
    fallback: ids.length > 0
      ? { en: `approve ${idList(ids)} from PR #${prNumber}`, es: `aprobar ${idList(ids)} del PR #${prNumber}` }
      : { en: `record the issues of PR #${prNumber}`, es: `anotar los issues del PR #${prNumber}` },
  };
}

export function redoCommitChange(redone: Array<{ id: string; titulo: string }>): CommitChange {
  const ids = redone.map((r) => r.id);
  return {
    description: `Replaces the "after" screenshot of these findings with a new one that applies the review's corrections:\n${redone.map((r) => `- ${r.id} ${r.titulo}`).join('\n')}`,
    fallback: { en: `redo the after image of ${idList(ids)}`, es: `rehacer la imagen del después de ${idList(ids)}` },
  };
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

const isBot = (login: string) => login.toLowerCase() === config.githubLogin.toLowerCase();

// A new comment on a finding file is feedback; inside a thread, a reply is
// only when it mentions ronin — people also talk among themselves there.
async function pendingFeedback(pr: PullRequestStatus): Promise<PendingFeedback[]> {
  const comments = await listFileReviewComments(pr.number);
  const rootOf = (c: { id: number; inReplyToId?: number }) => c.inReplyToId ?? c.id;
  const findingOf = (path: string) => path.match(FINDING_PATH_RE);
  const result: PendingFeedback[] = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin) continue;
    if (c.inReplyToId && !mentionsHandle(c.body, config.githubLogin)) continue;
    const match = findingOf(c.path);
    if (!match) continue;
    if (await isProcessed({ ...c, kind: 'review' })) continue;
    // Matched by app and id, not path: an edited title renames the file.
    const conversacion = comments
      .filter((o) => o.id < c.id && findingOf(o.path)?.[1] === match[1] && findingOf(o.path)?.[2] === match[2])
      .sort((a, b) => a.id - b.id)
      .map((o) => ({ autor: isBot(o.authorLogin) ? ('ronin' as const) : ('persona' as const), texto: o.body, mismoHilo: rootOf(o) === rootOf(c) }));
    result.push({ commentId: c.id, app: match[1], findingId: match[2], body: c.body, conversacion });
  }
  return result;
}

// A general comment on the PR that mentions ronin is feedback too: it can
// speak about several findings at once ("los de mobile") or about what the
// next explorations should leave alone.
async function pendingGeneralFeedback(pr: PullRequestStatus): Promise<GeneralFeedback[]> {
  const comments = (await listIssueComments(pr.number)).sort((a, b) => a.id - b.id);
  const result: GeneralFeedback[] = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin || !mentionsHandle(c.body, config.githubLogin)) continue;
    if (await isProcessed(c)) continue;
    const conversacion = comments
      .filter((o) => o.id < c.id)
      .map((o) => ({ autor: isBot(o.authorLogin) ? ('ronin' as const) : ('persona' as const), texto: o.body, mismoHilo: true }));
    result.push({ commentId: c.id, body: c.body, conversacion });
  }
  return result;
}

export interface RedoItem {
  app: string;
  findingId: string;
  instruction: string;
  commentId: number;
  // A general PR comment is answered as a new comment, not in a thread.
  kind?: 'issue' | 'review';
}

interface FindingAction {
  accion: string;
  motivo?: string;
  titulo?: string;
  propuesta?: string;
  rehacerDespues?: string;
}

interface FeedbackAction extends FindingAction {
  commentId: number;
  issue?: { titulo?: string; cuerpo?: string };
  respuesta?: string;
  // Only for a general comment: what it does to each finding it covers, and
  // what goes to the team's knowledge.
  fichas?: Array<FindingAction & { app?: string; findingId?: string }>;
  conocimiento?: Array<{ app?: string; texto?: string }>;
}

function clean(text: string): string {
  return text.replace(/@(?=\w)/g, '');
}

export function renderRejectedIssueClose(findingId: string, prNumber: number, motivo: string): string {
  return `Cierro este issue: la ficha ${findingId} se rechazó en el PR de exploración #${prNumber}. Motivo: ${motivo}\n\nSi igual hace falta, reabrilo.`;
}

// Applies what each new comment asks for — the agent only classifies it,
// the changes are made here: reject (finding + knowledge, and its issue
// closed if it had one), edit (title, proposal), add to the knowledge, open
// a follow-up issue. Redoing an after
// image needs the app running, so those come back for the worker.
async function applyFeedback(pr: PullRequestStatus, batch: string): Promise<RedoItem[]> {
  const [pending, general] = await Promise.all([pendingFeedback(pr), pendingGeneralFeedback(pr)]);
  if (pending.length === 0 && general.length === 0) return [];
  const batchDir = await ensureBatchWorktree(batch);
  const apps = await appsWithMemory(batchDir);
  const comments: FindingFeedback[] = [];
  for (const p of pending) {
    const memory = await loadMemory(memoryDirFor(batchDir, p.app));
    const meta = memory.findings.find((f) => f.id === p.findingId);
    comments.push({ commentId: p.commentId, findingId: p.findingId, titulo: meta?.titulo ?? p.findingId, body: p.body, conversacion: p.conversacion });
  }
  const fichas: FindingSummary[] = [];
  if (general.length > 0) {
    for (const app of apps) for (const f of (await loadMemory(memoryDirFor(batchDir, app))).findings) fichas.push({ app, id: f.id, titulo: f.titulo, estado: f.estado, viewport: f.viewport });
  }
  await mkdir(explorationOutDir(), { recursive: true });
  const outputPath = join(explorationOutDir(), `feedback-${pr.number}.json`);
  await rm(outputPath, { force: true });
  await runAgentTask(explorationTask({ type: 'explore-feedback', prNumber: pr.number, checkoutDir: batchDir, comments, ...(general.length > 0 ? { general, fichas } : {}), outputPath }));
  const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as { acciones?: FeedbackAction[] };

  const replies: Array<{ commentId: number; kind: 'issue' | 'review'; body: string }> = [];
  const redo: RedoItem[] = [];
  const changes: FeedbackChange[] = [];
  const knowledge: Array<{ app: string; texto: string }> = [];
  // A rejected finding that already had its issue (a bug opens one right
  // away): closed once the rejection is committed.
  const toClose: Array<{ issue: number; findingId: string; motivo: string }> = [];

  const applyToFinding = async (app: string, findingId: string, action: FindingAction, commentId: number, kind: 'issue' | 'review'): Promise<void> => {
    const memoryDir = memoryDirFor(batchDir, app);
    const meta = (await loadMemory(memoryDir)).findings.find((f) => f.id === findingId);
    if (!meta) return;
    const path = join(memoryDir, 'findings', findingFileName(meta));
    if (action.accion === 'rechazar' && action.motivo) {
      const finding = parseFinding(await readFile(path, 'utf8'));
      const motivo = action.motivo.trim().slice(0, 300);
      await writeFile(path, serializeFinding({ ...finding, estado: 'rechazado', motivo }));
      await appendKnowledge(memoryDir, `${motivo} (${findingId}, rechazada en #${pr.number})`);
      changes.push({ findingId, titulo: finding.titulo, kind: 'rechazada', detail: motivo });
      if (finding.issue) toClose.push({ issue: finding.issue, findingId, motivo });
    } else if (action.accion === 'editar') {
      const finding = parseFinding(await readFile(path, 'utf8'));
      const titulo = action.titulo?.trim() ? clip(action.titulo, LIMITS.titulo) : finding.titulo;
      let body = action.propuesta?.trim() ? replaceProposal(finding.body, action.propuesta.slice(0, 1600)) : finding.body;
      if (titulo !== finding.titulo) body = body.replace(/^## .*$/m, `## ${titulo}`);
      // The file name follows the title: a new title moves the file.
      await rm(path, { force: true });
      await writeFile(join(memoryDir, 'findings', findingFileName({ id: finding.id, titulo })), serializeFinding({ ...finding, titulo, body }));
      if (action.rehacerDespues?.trim()) redo.push({ app, findingId, instruction: action.rehacerDespues.trim().slice(0, 1200), commentId, ...(kind === 'issue' ? { kind } : {}) });
      const what = [titulo !== finding.titulo ? `new title "${titulo}"` : '', action.propuesta?.trim() ? `new proposal: ${action.propuesta.trim().slice(0, 300)}` : ''].filter(Boolean).join('; ');
      changes.push({ findingId, titulo, kind: 'editada', detail: what || 'proposal adjusted', redo: Boolean(action.rehacerDespues?.trim()) });
    }
  };

  // `app`: whose exploration it comes from, for its Linear project; unknown in
  // a general comment on a PR with findings of several apps.
  const openIssue = async (action: FeedbackAction, ref: string, reply: string, app: string | undefined): Promise<string> => {
    if (!action.issue?.titulo?.trim()) return reply;
    const created = await createIssue(clean(action.issue.titulo.trim()).slice(0, 200), `${clean(action.issue.cuerpo?.trim() ?? '')}\n\n${ref}`, []).catch((error) => {
      log.error(`exploración: no se pudo crear el issue pedido en el comentario ${action.commentId}`, error);
      return undefined;
    });
    if (created && app) await queueExplorationProject(app, created.number);
    return created ? `${reply}\n\nAbrí #${created.number}.`.trim() : `${reply}\n\nNo pude abrir el issue; el detalle está en el log del runner.`.trim();
  };

  for (const p of pending) {
    const action = parsed.acciones?.find((a) => a.commentId === p.commentId);
    if (!action) continue;
    let reply = action.respuesta ? clean(action.respuesta) : '';
    if (action.accion === 'crear-issue') reply = await openIssue(action, `Pedido en un comentario sobre la ficha ${p.findingId} del PR de exploración #${pr.number}.`, reply, p.app);
    else await applyToFinding(p.app, p.findingId, action, p.commentId, 'review');
    if (reply) replies.push({ commentId: p.commentId, kind: 'review', body: reply });
  }

  for (const g of general) {
    const action = parsed.acciones?.find((a) => a.commentId === g.commentId);
    if (!action) continue;
    let reply = action.respuesta ? clean(action.respuesta) : '';
    // The app is only needed to tell apart findings of different apps.
    const appOf = (app?: string) => (app && apps.includes(app) ? app : apps.length === 1 ? apps[0] : undefined);
    for (const f of action.fichas ?? []) {
      const app = appOf(f.app);
      if (app && f.findingId) await applyToFinding(app, f.findingId, f, g.commentId, 'issue');
    }
    for (const k of action.conocimiento ?? []) {
      const app = appOf(k.app);
      const texto = k.texto?.trim().slice(0, 300);
      if (!app || !texto) continue;
      await appendKnowledge(memoryDirFor(batchDir, app), `${texto} (pedido en #${pr.number})`);
      knowledge.push({ app, texto });
    }
    if (action.issue) reply = await openIssue(action, `Pedido en un comentario del PR de exploración #${pr.number}.`, reply, appOf(undefined));
    if (reply) replies.push({ commentId: g.commentId, kind: 'issue', body: reply });
  }

  if ((changes.length > 0 || knowledge.length > 0) && (await commitAndPush(batchDir, explorationBranch(batch), feedbackCommitChange(pr.number, changes, knowledge)))) await upsertExplorationPr(batch, batchDir);
  for (const c of toClose) {
    await closeIssueNotPlanned(c.issue, renderRejectedIssueClose(c.findingId, pr.number, c.motivo))
      .then((closed) => closed && log.info(`exploración: issue #${c.issue} cerrado, ${c.findingId} se rechazó en #${pr.number}`))
      .catch((error) => log.error(`exploración: no se pudo cerrar el issue #${c.issue} de ${c.findingId}, rechazada`, error));
  }
  for (const r of replies) await replyToComment(pr.number, { id: r.commentId, kind: r.kind }, r.body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${r.commentId}`, error));
  for (const p of pending) await markProcessed({ id: p.commentId, kind: 'review' }).catch(() => {});
  for (const g of general) await markProcessed({ id: g.commentId, kind: 'issue' }).catch(() => {});
  return redo;
}

// Accepting the PR: its findings still standing are marked approved and get
// their issue, committed to the PR so the base keeps both, and only then
// does the PR merge — mergePullRequest checks again that it's still
// approved. A retry after a failed merge has nothing left to mark and
// doesn't open a second issue (openFindingIssues looks for it first).
async function approveAndMerge(pr: PullRequestStatus, batch: string): Promise<void> {
  const batchDir = await ensureBatchWorktree(batch);
  // The issues link to the finding on the base, where it lands with the merge.
  const base = (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
  const approved: Array<{ id: string; titulo: string }> = [];
  for (const app of await appsWithMemory(batchDir)) {
    const memoryDir = memoryDirFor(batchDir, app);
    const ids = await approveFindings(memoryDir, () => true);
    await openFindingIssues(app, memoryDir, batchDir, base, (f) => f.estado === 'aprobado');
    const { findings } = await loadMemory(memoryDir);
    approved.push(...ids.map((id) => ({ id, titulo: findings.find((f) => f.id === id)?.titulo ?? id })));
  }
  if (approved.length > 0) log.info(`exploración: PR #${pr.number} aprobado, fichas aprobadas: ${approved.map((a) => a.id).join(', ')}`);
  if (await commitAndPush(batchDir, explorationBranch(batch), approveCommitChange(pr.number, approved))) await upsertExplorationPr(batch, batchDir);
  await mergePullRequest(pr.number);
  log.info(`exploración: PR #${pr.number} mergeado`);
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
  if (pr.reviewDecision === 'APPROVED') await approveAndMerge(pr, batch);
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
  const redone: Array<{ id: string; titulo: string }> = [];
  for (const key of done) {
    const [app, id] = key.split('/');
    const meta = (await loadMemory(memoryDirFor(batchDir, app))).findings.find((f) => f.id === id);
    redone.push({ id, titulo: meta?.titulo ?? id });
  }
  if (redone.length > 0 && (await commitAndPush(batchDir, explorationBranch(redo.batch), redoCommitChange(redone)))) await upsertExplorationPr(redo.batch, batchDir);
  for (const item of redo.items) {
    const ok = done.has(`${item.app}/${item.findingId}`);
    const body = ok
      ? `Rehice la imagen del después de ${item.findingId}; ya está en la ficha.`
      : `No pude rehacer la imagen del después de ${item.findingId}; el detalle está en el log del runner.`;
    await replyToComment(redo.prNumber, { id: item.commentId, kind: item.kind ?? 'review' }, body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${item.commentId}`, error));
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
  // Nightly runs stop starting new functions once the window closes; one
  // from the dashboard, once its time cap is up.
  until?: string;
  // Who started it from the dashboard (#155), for the run's record.
  by?: string;
  // Instead of a run: redo the after images reviewers asked for.
  redo?: { prNumber: number; batch: string; items: RedoItem[] };
}

function lockPath(): string {
  const slug = activeRepo().productRepo.replaceAll('/', '-');
  return join(activeRepo().worktreeBasePath, `.explore-${slug}.lock`);
}

export async function exploreWorkerBusy(): Promise<boolean> {
  return lockHeld(lockPath());
}

export async function acquireExploreLock(): Promise<boolean> {
  return acquireLock(lockPath());
}

export async function releaseExploreLock(): Promise<void> {
  await rm(lockPath(), { force: true });
}

// Starts the worker detached from the tick — see worker-launch.ts.
export function launchExploreWorker(request: ExploreWorkerRequest): void {
  const pid = launchWorker('exploration/worker', request);
  log.info(`exploración: worker lanzado para ${request.appName} (pid ${pid})`);
}

export async function reactToTrigger(trigger: ExploreWorkerRequest['trigger']): Promise<void> {
  if (!trigger) return;
  for (const id of trigger.commentIds) await markProcessed({ id, kind: 'issue' }).catch(() => {});
}
