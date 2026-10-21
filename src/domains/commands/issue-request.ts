import { markProcessed } from '../../platform/state/processed-comments.js';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentTask } from '../../platform/agents/agent-task.js';
import { commandTask } from './prompts.js';
import { getIssueBody, replyToComment, setIssueBody, type Comment } from '../../platform/github/github.js';
import { applyScopeChange, appendInvestigation } from './issue-sections.js';
import { launchPrototypeWorker } from './prototype.js';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { requestBranch } from '../slices/index.js';
import { removeWorktree } from '../../platform/git/worktree.js';
import { log } from '../../platform/logger.js';

// A mention with no command on an issue ronin wasn't assigned yet: change
// the scope, look into something, draw a prototype, or answer — whatever
// the comment asks, never a PR. A read-only agent says what to do; the
// supervisor writes it, so the body only ever changes in the sections
// issue-sections.ts owns. See docs/DESIGN.md §11.11.

export interface IssueRequestCandidate {
  issueNumber: number;
  trigger: Comment;
}

export interface IssueRequestResult {
  alcance?: { texto: string; cambio: string };
  contexto?: string;
  prototipo?: { app: string; instruccion: string };
  respuesta: string;
}

const MAX_SECTION = 20_000;
const MAX_REPLY = 4_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// A missing or malformed optional part is dropped, not fatal: the reply is
// what the person is waiting for. Only a missing reply fails the run.
export function parseIssueRequestResult(raw: string): IssueRequestResult {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('el resultado no es un objeto JSON');
  const reply = nonEmpty(parsed.respuesta, MAX_REPLY);
  if (!reply) throw new Error('el resultado no trae "respuesta"');
  const result: IssueRequestResult = { respuesta: reply };
  if (isObject(parsed.alcance)) {
    const texto = nonEmpty(parsed.alcance.texto, MAX_SECTION);
    const cambio = nonEmpty(parsed.alcance.cambio, 300);
    if (texto && cambio) result.alcance = { texto, cambio };
  }
  const contexto = nonEmpty(parsed.contexto, MAX_SECTION);
  if (contexto) result.contexto = contexto;
  if (isObject(parsed.prototipo)) {
    const app = nonEmpty(parsed.prototipo.app, 100);
    const instruccion = nonEmpty(parsed.prototipo.instruccion, 2_000);
    if (app && /^[\w.-]+$/.test(app) && instruccion) result.prototipo = { app, instruccion };
  }
  return result;
}

export function commentUrl(issueNumber: number, commentId: number): string {
  return `https://github.com/${activeRepo().productRepo}/issues/${issueNumber}#issuecomment-${commentId}`;
}

// The body with the scope change and/or the investigation in, or the same
// body when the result asks for neither.
export function nextIssueBody(body: string, result: IssueRequestResult, opts: { commentUrl: string; date: string }): string {
  let next = body;
  if (result.alcance) next = applyScopeChange(next, { alcance: result.alcance.texto, cambio: result.alcance.cambio, ...opts });
  if (result.contexto) next = appendInvestigation(next, { contexto: result.contexto, ...opts });
  return next;
}

export async function processIssueRequest(candidate: IssueRequestCandidate): Promise<void> {
  const { issueNumber, trigger } = candidate;
  const outDir = join(activeRepo().worktreeBasePath, 'issue-request-out', `${issueNumber}-${trigger.id}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  try {
    const outputPath = join(outDir, 'result.json');
    await runAgentTask(commandTask({ type: 'issue-request', issueNumber, trigger, outputPath }));
    const result = parseIssueRequestResult(await readFile(outputPath, 'utf8'));

    let reply = result.respuesta;
    if (result.alcance || result.contexto) {
      // Read right before writing: the agent ran for minutes, and someone
      // may have edited the description meanwhile.
      const body = await getIssueBody(issueNumber);
      const next = nextIssueBody(body, result, { commentUrl: commentUrl(issueNumber, trigger.id), date: new Date().toISOString().slice(0, 10) });
      if (next !== body) await setIssueBody(issueNumber, next);
    }
    if (result.prototipo) {
      launchPrototypeWorker({
        repo: activeRepo().productRepo,
        issueNumber,
        appName: result.prototipo.app,
        instruction: result.prototipo.instruccion,
        commentId: trigger.id,
      });
      reply += `\n\nArranco el prototipo en \`${result.prototipo.app}\`: cuando esté, dejo acá las capturas del antes y el después.`;
    }
    await replyToComment(issueNumber, trigger, reply);
  } catch (error) {
    log.error(`issue #${issueNumber}: el pedido del comentario ${trigger.id} falló`, error);
    await replyToComment(issueNumber, trigger, `No pude atender este pedido: ${(error as Error).message.split('\n')[0].slice(0, 300)}. El detalle está en el log del runner.`).catch(() => {});
  } finally {
    // Reacted to on success and failure alike, like /spec: a request that
    // fails is answered, not retried every tick at the cost of another run.
    await markProcessed(trigger).catch(() => {});
    await removeWorktree(requestBranch(issueNumber)).catch(() => {});
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
