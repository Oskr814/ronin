import { isProcessed, markProcessed } from '@platform/state/processed-comments.js';
import { join } from 'node:path';
import { activeRepo } from '@platform/agents/repo-context.js';
import { launchWorker } from '@platform/workers/worker-launch.js';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { queueExplorationProject } from '@platform/linear/linear-assign.js';
import { dayIn } from '@platform/config/timezone.js';
import { runAgentTask } from '@platform/agents/agent-task.js';
import { explorationTask, type FindingFeedback, type FindingSummary, type GeneralFeedback } from './prompts.js';
import {
  closeIssueNotPlanned,
  commentOnIssue,
  createIssue,
  getDiscussion,
  type Discussion,
  listFileReviewComments,
  listIssueComments,
  listIssuesWithLabel,
  listOpenPrsByHeadPrefix,
  markPullRequestReady,
  mergePullRequest,
  replyToComment,
  type FileReviewComment,
  type PullRequestStatus,
} from '@platform/github/github.js';
import { ensureAppWorktree } from '../product-app/index.js';
import { appendKnowledge, EXPLORATION_DIR, findingFileName, loadMemory, memoryDirFor, parseFinding, serializeFinding } from './memory.js';
import { explorationOutDir } from './inventory.js';
import { runExploration, type RunSummary } from './run.js';
import { hasFocus, type ExploreFocus } from './plan.js';
import {
  appsWithMemory,
  approveFindings,
  batchOfBranch,
  commitAndPush,
  currentBatch,
  ensureBatchWorktree,
  ensureFindingIssue,
  findingIssueKey,
  explorationBranch,
  EXPLORATION_BRANCH_PREFIX,
  LABEL_PROPOSAL,
  openFindingIssues,
  reconcileApproved,
  upsertExplorationPr,
} from './pr.js';
import { clip, LIMITS, replaceProposal } from './output.js';
import { redoAfterImages } from './redo.js';
import { readBranchFile } from './review.js';
import { mentionsHandle } from '../commands/index.js';
import type { CommitChange } from '@platform/git/commit-style.js';
import { worktreeLock } from '@platform/workers/worktree-lock.js';
import { host } from '@platform/host/host.js';

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
  focus?: ExploreFocus;
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
    ...(hasFocus(opts.focus) ? { focus: opts.focus } : {}),
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
  const lines = summary.unfocused
    ? [`No exploré \`${appName}\`: ${summary.unfocused}. Si el pedido es de otra app, pedímelo con esa; si es de esta, contame en qué pantalla está y volvé a pedirlo.`, '']
    : [
        `Exploré \`${appName}\`${summary.focus?.issue ? ' con foco en lo que pide este issue' : ''}: ${explored.length > 0 ? explored.join(', ') : 'ninguna función'}${failed.length > 0 ? `; fallaron ${failed.join(', ')}` : ''}.`,
        '',
      ];
  if (summary.unfocused) return lines.join('\n').trim();
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

const REQUEST_MAX = 6000;

// What an issue asks for, as the focus of an /explore on it (#376): its
// title and body, and what people said in its comments — the commands to
// ronin (their name and app) left out, bots' comments too. Undefined
// when nothing but the title and the command is there: that /explore runs as
// at night.
export function issueRequest(issue: Pick<Discussion, 'title' | 'body' | 'comments'>, bot = config.githubLogin): string | undefined {
  const command = new RegExp(`@${bot}\\s+/[\\w-]+(?:[ \\t]+[\\w.-]+(?:[ \\t]+\\d+(?=\\s|$))?)?`, 'gi');
  const said: string[] = [];
  const body = issue.body.trim();
  if (body) said.push(body);
  for (const c of issue.comments) {
    if (!c.author || c.author.toLowerCase() === bot.toLowerCase() || c.author.endsWith('[bot]')) continue;
    // Of the /explore itself, only what comes after its app and count.
    const text = c.body.replace(command, '').trim();
    if (text) said.push(text);
  }
  if (said.length === 0) return undefined;
  return [`# ${issue.title.trim()}`, ...said].join('\n\n').slice(0, REQUEST_MAX);
}

// The focus of an /explore: the request of the issue it was asked on, read
// when the run starts so it has every comment up to then.
export async function issueFocus(trigger: NonNullable<ExploreWorkerRequest['trigger']>): Promise<ExploreFocus | undefined> {
  const text = issueRequest(await getDiscussion('issue', trigger.issueNumber));
  return text ? { text, issue: trigger.issueNumber } : undefined;
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
  // Who wrote it: who the finding's decision is recorded under.
  author: string;
  body: string;
  conversacion: NonNullable<FindingFeedback['conversacion']>;
}

const isBot = (login: string) => login.toLowerCase() === config.githubLogin.toLowerCase();

// A new comment on a finding file is feedback; inside a thread, a reply is
// only when it mentions ronin — people also talk among themselves there.
async function pendingFeedback(comments: FileReviewComment[]): Promise<PendingFeedback[]> {
  const rootOf = (c: { id: number; inReplyToId?: number }) => c.inReplyToId ?? c.id;
  const findingOf = (path: string) => path.match(FINDING_PATH_RE);
  const result: PendingFeedback[] = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin) continue;
    if (c.inReplyToId && !mentionsHandle(c.body, config.githubLogin)) continue;
    // Sending it to development is the code's (developNow), not the agent's.
    if (!c.inReplyToId && developRequest(c.body) !== null) continue;
    const match = findingOf(c.path);
    if (!match) continue;
    if (await isProcessed({ ...c, kind: 'review' })) continue;
    // Matched by app and id, not path: an edited title renames the file.
    const conversacion = comments
      .filter((o) => o.id < c.id && findingOf(o.path)?.[1] === match[1] && findingOf(o.path)?.[2] === match[2])
      .sort((a, b) => a.id - b.id)
      .map((o) => ({ autor: isBot(o.authorLogin) ? ('ronin' as const) : ('persona' as const), texto: o.body, mismoHilo: rootOf(o) === rootOf(c) }));
    result.push({ commentId: c.id, app: match[1], findingId: match[2], author: c.authorLogin, body: c.body, conversacion });
  }
  return result;
}

// A general comment on the PR that mentions ronin is feedback too: it can
// speak about several findings at once ("los de mobile") or about what the
// next explorations should leave alone.
async function pendingGeneralFeedback(pr: PullRequestStatus): Promise<Array<GeneralFeedback & { author: string }>> {
  const comments = (await listIssueComments(pr.number)).sort((a, b) => a.id - b.id);
  const result: Array<GeneralFeedback & { author: string }> = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin || !mentionsHandle(c.body, config.githubLogin)) continue;
    if (await isProcessed(c)) continue;
    const conversacion = comments
      .filter((o) => o.id < c.id)
      .map((o) => ({ autor: isBot(o.authorLogin) ? ('ronin' as const) : ('persona' as const), texto: o.body, mismoHilo: true }));
    result.push({ commentId: c.id, author: c.authorLogin, body: c.body, conversacion });
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
async function applyFeedback(pr: PullRequestStatus, batch: string, fileComments: FileReviewComment[]): Promise<RedoItem[]> {
  const [pending, general] = await Promise.all([pendingFeedback(fileComments), pendingGeneralFeedback(pr)]);
  if (pending.length === 0 && general.length === 0) return [];
  const batchDir = await ensureBatchWorktree(batch);
  const apps = await appsWithMemory(batchDir);
  const comments: FindingFeedback[] = [];
  for (const p of pending) {
    const memory = await loadMemory(memoryDirFor(batchDir, p.app));
    const meta = memory.findings.find((f) => f.id === p.findingId);
    comments.push({ commentId: p.commentId, findingId: p.findingId, titulo: meta?.titulo ?? p.findingId, body: p.body, conversacion: p.conversacion });
  }
  const cards: FindingSummary[] = [];
  if (general.length > 0) {
    for (const app of apps) for (const f of (await loadMemory(memoryDirFor(batchDir, app))).findings) cards.push({ app, id: f.id, titulo: f.titulo, estado: f.estado, viewport: f.viewport });
  }
  // A directory of its own: the agent writes only there (sealed, #257).
  const outDir = join(explorationOutDir(), `feedback-${pr.number}`);
  await host().fs.rm(outDir, { recursive: true, force: true });
  await host().fs.mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, 'feedback.json');
  await runAgentTask(explorationTask({ type: 'explore-feedback', prNumber: pr.number, checkoutDir: batchDir, comments, ...(general.length > 0 ? { general: general.map(({ author: _author, ...g }) => g), fichas: cards } : {}), outputPath }));
  const parsed = JSON.parse(await host().fs.readFile(outputPath, 'utf8')) as { acciones?: FeedbackAction[] };

  const replies: Array<{ commentId: number; kind: 'issue' | 'review'; body: string }> = [];
  const redo: RedoItem[] = [];
  const changes: FeedbackChange[] = [];
  const knowledge: Array<{ app: string; texto: string }> = [];
  // A rejected finding that already had its issue (a bug opens one right
  // away): closed once the rejection is committed.
  const toClose: Array<{ issue: number; findingId: string; motivo: string }> = [];

  const applyToFinding = async (app: string, findingId: string, action: FindingAction, commentId: number, kind: 'issue' | 'review', author: string): Promise<void> => {
    const reviewed = { revisor: author, revisado: new Date().toISOString() };
    const memoryDir = memoryDirFor(batchDir, app);
    const meta = (await loadMemory(memoryDir)).findings.find((f) => f.id === findingId);
    if (!meta) return;
    const path = join(memoryDir, 'findings', findingFileName(meta));
    if (action.accion === 'rechazar' && action.motivo) {
      const finding = parseFinding(await host().fs.readFile(path, 'utf8'));
      const reason = action.motivo.trim().slice(0, 300);
      await host().fs.writeFile(path, serializeFinding({ ...finding, estado: 'rechazado', motivo: reason, ...reviewed }));
      await appendKnowledge(memoryDir, `${reason} (${findingId}, rechazada en #${pr.number})`);
      changes.push({ findingId, titulo: finding.titulo, kind: 'rechazada', detail: reason });
      if (finding.issue) toClose.push({ issue: finding.issue, findingId, motivo: reason });
    } else if (action.accion === 'editar') {
      const finding = parseFinding(await host().fs.readFile(path, 'utf8'));
      const title = action.titulo?.trim() ? clip(action.titulo, LIMITS.titulo) : finding.titulo;
      let body = action.propuesta?.trim() ? replaceProposal(finding.body, action.propuesta.slice(0, 1600)) : finding.body;
      if (title !== finding.titulo) body = body.replace(/^## .*$/m, `## ${title}`);
      // The file name follows the title: a new title moves the file.
      await host().fs.rm(path, { force: true });
      await host().fs.writeFile(join(memoryDir, 'findings', findingFileName({ id: finding.id, titulo: title })), serializeFinding({ ...finding, titulo: title, body, ...reviewed }));
      if (action.rehacerDespues?.trim()) redo.push({ app, findingId, instruction: action.rehacerDespues.trim().slice(0, 1200), commentId, ...(kind === 'issue' ? { kind } : {}) });
      const what = [title !== finding.titulo ? `new title "${title}"` : '', action.propuesta?.trim() ? `new proposal: ${action.propuesta.trim().slice(0, 300)}` : ''].filter(Boolean).join('; ');
      changes.push({ findingId, titulo: title, kind: 'editada', detail: what || 'proposal adjusted', redo: Boolean(action.rehacerDespues?.trim()) });
    }
  };

  // `app`: whose exploration it comes from, for its Linear project; unknown in
  // a general comment on a PR with findings of several apps. Assigned to
  // ronin, like a finding's issue: asking for it in the PR is the decision.
  const openIssue = async (action: FeedbackAction, ref: string, reply: string, app: string | undefined): Promise<string> => {
    if (!action.issue?.titulo?.trim()) return reply;
    const created = await createIssue(clean(action.issue.titulo.trim()).slice(0, 200), `${clean(action.issue.cuerpo?.trim() ?? '')}\n\n${ref}`, [], [config.githubLogin]).catch((error) => {
      log.error(`exploración: no se pudo crear el issue pedido en el comentario ${action.commentId}`, error);
      return undefined;
    });
    if (created && app) await queueExplorationProject(app, created.number);
    return created ? `${reply}\n\nAbrí #${created.number} y me lo asigné.`.trim() : `${reply}\n\nNo pude abrir el issue; el detalle está en el log del runner.`.trim();
  };

  for (const p of pending) {
    const action = parsed.acciones?.find((a) => a.commentId === p.commentId);
    if (!action) continue;
    let reply = action.respuesta ? clean(action.respuesta) : '';
    if (action.accion === 'crear-issue') reply = await openIssue(action, `Pedido en un comentario sobre la ficha ${p.findingId} del PR de exploración #${pr.number}.`, reply, p.app);
    else await applyToFinding(p.app, p.findingId, action, p.commentId, 'review', p.author);
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
      if (app && f.findingId) await applyToFinding(app, f.findingId, f, g.commentId, 'issue', g.author);
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
  // Who approved the PR: the findings' reviewers.
  const revisor = await getDiscussion('pr', pr.number)
    .then((d) => (d.decisions ?? []).filter((x) => x.state === 'APPROVED' && !isBot(x.author)).map((x) => x.author).join(', ') || undefined)
    .catch(() => undefined);
  // Approved now, by the issue whose request they came from (#376).
  const byOrigin = new Map<number, Array<{ id: string; titulo: string; issue?: number }>>();
  for (const app of await appsWithMemory(batchDir)) {
    const memoryDir = memoryDirFor(batchDir, app);
    const ids = await approveFindings(memoryDir, () => true, revisor);
    await openFindingIssues(app, memoryDir, batchDir, base, (f) => f.estado === 'aprobado');
    const { findings } = await loadMemory(memoryDir);
    approved.push(...ids.map((id) => ({ id, titulo: findings.find((f) => f.id === id)?.titulo ?? id })));
    for (const f of findings.filter((x) => ids.includes(x.id) && x.origen)) {
      byOrigin.set(f.origen!, [...(byOrigin.get(f.origen!) ?? []), { id: f.id, titulo: f.titulo, ...(f.issue ? { issue: f.issue } : {}) }]);
    }
  }
  if (approved.length > 0) log.info(`exploración: PR #${pr.number} aprobado, fichas aprobadas: ${approved.map((a) => a.id).join(', ')}`);
  if (await commitAndPush(batchDir, explorationBranch(batch), approveCommitChange(pr.number, approved))) await upsertExplorationPr(batch, batchDir);
  await mergePullRequest(pr.number);
  log.info(`exploración: PR #${pr.number} mergeado`);
  for (const [issue, findings] of byOrigin) {
    await commentOnIssue(issue, renderOriginReply(pr.number, findings))
      .catch((error) => log.error(`exploración: no se pudo avisar en #${issue} lo aprobado del PR #${pr.number}`, error));
  }
}

// What the issue a focused run came from (#376) is told once the
// exploration PR is approved: which of its proposals stood, and their issues.
export function renderOriginReply(prNumber: number, findings: Array<{ id: string; titulo: string; issue?: number }>): string {
  return [
    `Se aprobó el PR de exploración #${prNumber}. De lo que se pidió acá quedaron en pie estas propuestas, cada una con su issue:`,
    '',
    ...findings.map((f) => `- ${f.issue ? `#${f.issue}` : f.id} ${f.titulo}`),
  ].join('\n');
}

// "Desarrollar ya" on a finding (#379), as the dashboard writes it: the
// context after it ('' for none), or null for any other comment. Fixed
// words, read by the code: sending a finding to development isn't left to
// how the agent reads a comment.
const DEVELOP_RE = /^\s*desarrollar ya\b[.:]?\s*([\s\S]*)$/i;
export function developRequest(body: string): string | null {
  const match = DEVELOP_RE.exec(body);
  return match ? match[1].trim() : null;
}

export function developCommitChange(prNumber: number, developed: Array<{ id: string; titulo: string; issue: number }>): CommitChange {
  const ids = developed.map((d) => d.id);
  return {
    description: `Before PR #${prNumber} is approved, these findings were sent to development: marks them approved and records the issue opened for each one:\n${developed.map((d) => `- ${d.id} ${d.titulo} (#${d.issue})`).join('\n')}`,
    fallback: { en: `send ${idList(ids)} to development from PR #${prNumber}`, es: `mandar ${idList(ids)} a desarrollar desde el PR #${prNumber}` },
  };
}

// Sends the findings asked for to development before the PR is approved
// (#379): each one gets its own issue now, assigned to ronin, with the key
// approveAndMerge looks for, so approving the PR later opens no second one.
// `write`: whether the branch can be written — not while a run of the repo
// is on it. Then the issue goes out anyway, and the finding is marked
// approved (and the comment done) once the run is over.
export async function developNow(pr: PullRequestStatus, batch: string, comments: FileReviewComment[], write: boolean): Promise<void> {
  const asks: Array<{ c: FileReviewComment; app: string; id: string; context: string }> = [];
  for (const c of comments) {
    if (isBot(c.authorLogin) || !c.authorLogin || c.inReplyToId) continue;
    const match = c.path.match(FINDING_PATH_RE);
    const context = developRequest(c.body);
    if (!match || context === null || (await isProcessed({ ...c, kind: 'review' }))) continue;
    asks.push({ c, app: match[1], id: match[2], context });
  }
  if (asks.length === 0) return;
  const existing = await listIssuesWithLabel(LABEL_PROPOSAL);
  const base = (activeRepo().worktreeBaseRef ?? config.worktreeBaseRef).replace(/^origin\//, '');
  const batchDir = write ? await ensureBatchWorktree(batch) : undefined;
  const developed: Array<{ id: string; titulo: string; issue: number; commentId: number }> = [];
  const done: number[] = [];
  const reply = (c: FileReviewComment, body: string) => replyToComment(pr.number, { id: c.id, kind: 'review' }, body).catch((error) => log.error(`exploración: no se pudo responder el comentario ${c.id}`, error));
  for (const { c, app, id, context } of asks) {
    // From the checkout when it can be written, and from the PR's branch otherwise.
    let path: string | undefined;
    let raw: string | null = null;
    if (batchDir) {
      const memoryDir = memoryDirFor(batchDir, app);
      const meta = (await loadMemory(memoryDir)).findings.find((f) => f.id === id);
      path = meta ? join(memoryDir, 'findings', findingFileName(meta)) : undefined;
      raw = path ? await host().fs.readFile(path, 'utf8') : null;
    } else {
      raw = await readBranchFile(activeRepo(), pr.headRefName, c.path);
    }
    if (!raw) {
      if (batchDir) {
        await reply(c, `No encuentro la ficha ${id} en este PR: no la mandé a desarrollar.`);
        done.push(c.id);
      }
      continue;
    }
    const finding = parseFinding(raw);
    if (finding.estado === 'rechazado' || finding.issue) {
      await reply(c, finding.issue ? `${id} ya tiene su issue: #${finding.issue}.` : `${id} está rechazada: no la mandé a desarrollar. Si igual hace falta, pedí un issue aparte.`);
      done.push(c.id);
      continue;
    }
    const note = [
      `Se mandó a desarrollar desde el PR de exploración #${pr.number}, antes de aprobarlo, a pedido de ${c.authorLogin}.`,
      ...(context ? ['', `Contexto: ${clean(context)}`] : []),
    ].join('\n');
    const issue = await ensureFindingIssue(app, finding, `https://github.com/${activeRepo().productRepo}/blob/${base}/${c.path}`, { existing, note });
    if (issue.created) {
      existing.push({ number: issue.number, body: findingIssueKey(app, id), state: 'OPEN' });
      await reply(c, `Abrí #${issue.number} y me lo asigné: lo empiezo en el próximo tick. Al aprobar el PR, esta ficha no abre otro.${batchDir ? '' : ' La ficha queda aprobada cuando termine la exploración que está corriendo.'}`);
    }
    if (!batchDir || !path) continue;
    await host().fs.writeFile(path, serializeFinding({ ...finding, estado: 'aprobado', issue: issue.number, revisor: c.authorLogin, revisado: new Date().toISOString() }));
    developed.push({ id, titulo: finding.titulo, issue: issue.number, commentId: c.id });
  }
  if (batchDir && developed.length > 0 && (await commitAndPush(batchDir, explorationBranch(batch), developCommitChange(pr.number, developed)))) {
    await upsertExplorationPr(batch, batchDir);
  }
  for (const id of [...done, ...developed.map((d) => d.commentId)]) await markProcessed({ id, kind: 'review' }).catch(() => {});
  if (developed.length > 0) log.info(`exploración: PR #${pr.number}, mandadas a desarrollar: ${developed.map((d) => `${d.id} (#${d.issue})`).join(', ')}`);
}

export async function processExplorationPr(pr: PullRequestStatus): Promise<void> {
  const batch = batchOfBranch(pr.headRefName);
  if (!batch) return;
  // While the worker writes this branch, only what needs no commit: the
  // issue of a finding sent to development.
  const busy = await exploreWorkerBusy();
  const comments = await listFileReviewComments(pr.number);
  await developNow(pr, batch, comments, !busy).catch((error) => log.error(`exploración: no se pudo mandar a desarrollar desde el PR #${pr.number}`, error));
  if (busy) return;
  const redo = await applyFeedback(pr, batch, comments);
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
  // Where to look, from Explorar ahora (#376). An /explore's is its issue's
  // request, read by the worker when it starts (issueFocus).
  focus?: ExploreFocus;
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

const lock = () => worktreeLock(`explore-${activeRepo().productRepo.replaceAll('/', '-')}`);

export function exploreWorkerBusy(): Promise<boolean> {
  return lock().busy();
}

export function acquireExploreLock(): Promise<boolean> {
  return lock().acquire();
}

export function releaseExploreLock(): Promise<void> {
  return lock().release();
}

// Starts the worker detached from the tick — see worker-launch.ts.
export function launchExploreWorker(request: ExploreWorkerRequest): void {
  const pid = launchWorker('domains/explorations/worker', request);
  log.info(`exploración: worker lanzado para ${request.appName} (${pid ? `pid ${pid}` : 'en la cola del runner'})`);
}

export async function reactToTrigger(trigger: ExploreWorkerRequest['trigger']): Promise<void> {
  if (!trigger) return;
  for (const id of trigger.commentIds) await markProcessed({ id, kind: 'issue' }).catch(() => {});
}
