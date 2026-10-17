import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runAgentTask } from '../core/agent-task.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { sendMail } from '../core/notifier.js';
import { activeRepo } from '../core/repo-context.js';
import { removeWorktreeDir } from '../core/worktree.js';
import { getUser, type PortalUser } from './accounts.js';
import { bigRequestMail, PORTAL_FROM_NAME, replyMail, teamRequestMail } from './mail.js';
import { addRoninMessage, getRequest, requestImagePath, TITLE_MAX, updateRequest, type PortalRequest, type Verdict } from './requests.js';

const execFileAsync = promisify(execFile);

// ronin reads a portal request (#114) and does one of four things: asks the
// person something, answers them, or decides it's a small change (the
// prototype comes next) or one for the dev team. A read-only agent decides;
// this writes the reply, so the person only ever sees what passes through
// here.

export const MAX_QUESTIONS = 3;
const MAX_MESSAGE = 3000;
const MAX_FIELD = 4000;

export type PortalAction = 'preguntar' | 'responder' | 'menor' | 'grande';

export interface PortalResult {
  accion: PortalAction;
  mensaje: string;
  titulo?: string;
  propuesta?: string;
  instruccion?: string;
  motivo?: string;
  resumen?: string;
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// What the agent wrote. A small change without what the prototype needs, or
// a question past the limit, goes to the team: never left half-decided.
export function parsePortalResult(raw: string, questionsAsked: number): PortalResult {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('el resultado no es un objeto JSON');
  const r = parsed as Record<string, unknown>;
  const mensaje = text(r.mensaje, MAX_MESSAGE);
  if (!mensaje) throw new Error('el resultado no trae "mensaje"');
  if (!['preguntar', 'responder', 'menor', 'grande'].includes(r.accion as string)) throw new Error(`"accion" inválida: ${String(r.accion)}`);
  const result: PortalResult = { accion: r.accion as PortalAction, mensaje };
  for (const [key, max] of [['titulo', TITLE_MAX], ['propuesta', MAX_FIELD], ['instruccion', MAX_FIELD], ['motivo', MAX_FIELD], ['resumen', MAX_FIELD]] as const) {
    const value = text(r[key], max);
    if (value) result[key] = value;
  }
  if (result.accion === 'menor' && (!result.propuesta || !result.instruccion)) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'No quedó claro qué cambiar.' };
  }
  if (result.accion === 'preguntar' && questionsAsked >= MAX_QUESTIONS) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'Hicieron falta más datos de los que se pueden pedir aquí.', mensaje: 'Para entender bien lo que necesitas hace falta conversarlo con el equipo.' };
  }
  return result;
}

export const NEXT_STEP: Record<'menor' | 'grande', string> = {
  menor: 'Voy a armar un prototipo para que veas cómo quedaría antes de hacer el cambio. Te aviso aquí y por correo cuando esté listo.',
  grande: 'Se lo envié al equipo de desarrollo con tu descripción y tus imágenes. Te aviso por correo cuando esté resuelto.',
};

// The reply the person sees, and where the request goes.
export function applyResult(request: PortalRequest, result: PortalResult, now = new Date()): void {
  if (result.titulo && request.messages.filter((m) => m.from === 'ronin').length === 0) request.title = result.titulo;
  delete request.worker;
  if (result.accion === 'preguntar' || result.accion === 'responder') {
    addRoninMessage(request, result.mensaje, now);
    request.status = result.accion === 'preguntar' ? 'asking' : 'answered';
    if (result.accion === 'preguntar') request.questions += 1;
    return;
  }
  const kind = result.accion === 'menor' ? 'minor' : 'big';
  const verdict: Verdict = { kind, summary: result.resumen ?? '', at: now.toISOString() };
  if (kind === 'minor') {
    verdict.proposal = result.propuesta;
    verdict.instruction = result.instruccion;
  } else if (result.motivo) verdict.reason = result.motivo;
  request.verdict = verdict;
  request.status = kind;
  const proposal = kind === 'minor' ? `\n\nLa propuesta: ${result.propuesta}` : '';
  addRoninMessage(request, `${result.mensaje}${proposal}\n\n${NEXT_STEP[result.accion as 'menor' | 'grande']}`, now);
}

export const FAILED_REPLY = 'Tuve un problema al revisar tu pedido. Escríbeme de nuevo en unos minutos para que lo intente otra vez.';

// A detached checkout of the base branch, of its own: it leaves no branch
// behind, and two requests never share one.
async function checkout(n: number): Promise<string> {
  const repo = activeRepo();
  const dir = join(repo.worktreeBasePath, `portal-P-${n}`);
  if (existsSync(dir)) await removeWorktreeDir(dir, 'portal');
  await mkdir(repo.worktreeBasePath, { recursive: true });
  await execFileAsync('git', ['fetch', 'origin'], { cwd: repo.productRepoPath }).catch(() => {});
  await execFileAsync('git', ['worktree', 'add', '--detach', dir, repo.worktreeBaseRef ?? config.worktreeBaseRef], { cwd: repo.productRepoPath });
  return dir;
}

// The person always hears back by email (they may have closed the page);
// the team, when there's something for them: a small change or a big one.
async function notify(request: PortalRequest, user: PortalUser | undefined): Promise<void> {
  const sends: Array<Promise<void>> = [];
  if (user) sends.push(sendMail(request.status === 'big' ? bigRequestMail(request, user, config.portal.url) : replyMail(request, user, config.portal.url), PORTAL_FROM_NAME));
  if (request.status === 'minor' || request.status === 'big') sends.push(sendMail(teamRequestMail(request, user, config.notifyTo, dirname(requestImagePath(request.number, 'x'))), PORTAL_FROM_NAME));
  for (const result of await Promise.allSettled(sends)) {
    if (result.status === 'rejected') log.error(`portal: no se pudo enviar un correo del pedido P-${request.number}`, result.reason);
  }
}

// Inside withActiveRepo, for a request that's 'thinking'. Never throws: a
// failure is answered to the person, who can write again.
export async function classifyRequest(n: number): Promise<void> {
  const request = await getRequest(n);
  if (!request || request.status !== 'thinking') return;
  const outDir = join(activeRepo().worktreeBasePath, 'portal-request-out', `P-${n}`);
  let dir: string | undefined;
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    dir = await checkout(n);
    const outputPath = join(outDir, 'result.json');
    await runAgentTask({
      type: 'portal-request',
      requestNumber: n,
      appName: request.app,
      conversation: request.messages.map((m) => ({ from: m.from, text: m.text, images: m.images.map((file) => requestImagePath(n, file)) })),
      questionsLeft: Math.max(0, MAX_QUESTIONS - request.questions),
      checkoutDir: dir,
      outputPath,
    });
    const result = parsePortalResult(await readFile(outputPath, 'utf8'), request.questions);
    const updated = await updateRequest(n, (r) => {
      applyResult(r, result);
      return r;
    });
    log.info(`portal: pedido P-${n} → ${result.accion}`);
    await notify(updated, await getUser(updated.userId));
  } catch (error) {
    log.error(`portal: no se pudo revisar el pedido P-${n}`, error);
    try {
      const failed = await updateRequest(n, (r) => {
        addRoninMessage(r, FAILED_REPLY);
        r.status = 'asking';
        delete r.worker;
        return r;
      });
      await notify(failed, await getUser(failed.userId));
    } catch (e) {
      log.error(`portal: no se pudo guardar la falla del pedido P-${n}`, e);
    }
  } finally {
    if (dir) await removeWorktreeDir(dir, 'portal').catch(() => {});
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
