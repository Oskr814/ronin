import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runAgentTask } from '../core/agent-task.js';
import { portalTask } from './prompts.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { removeWorktreeDir } from '../core/worktree.js';
import { getUser, type PortalUser } from './accounts.js';
import { interviewText, MAX_ROUNDS, parseQuestions } from './interview.js';
import { interviewMail, replyMail } from './mail.js';
import { handOverMail, sendPortalMails } from './notify.js';
import { addEvent, addRoninMessage, errorLine, getRequest, MAX_PROTOTYPES, MAX_REPRODUCTIONS, requestImagePath, TITLE_MAX, updateUnlessCancelled, type InterviewQuestion, type PortalRequest, type Verdict } from './requests.js';

const execFileAsync = promisify(execFile);

// ronin reads a portal request (#114) and does one of six things: asks the
// person something, answers them, or decides it's a small change (the
// prototype comes next), a reported error (reproducing it comes next, #137),
// one for the dev team, or one for the team that first needs the person's
// decisions — it interviews them (#225). A read-only agent decides; this writes the
// reply, so the person only ever sees what passes through here.

export const MAX_QUESTIONS = 3;
const MAX_MESSAGE = 3000;
const MAX_FIELD = 4000;

export type PortalAction = 'preguntar' | 'responder' | 'menor' | 'error' | 'grande' | 'entrevistar';
const ACTIONS: PortalAction[] = ['preguntar', 'responder', 'menor', 'error', 'grande', 'entrevistar'];

export interface PortalResult {
  accion: PortalAction;
  mensaje: string;
  titulo?: string;
  propuesta?: string;
  instruccion?: string;
  motivo?: string;
  resumen?: string;
  // error: the steps to reproduce it, as ronin understood them.
  pasos?: string;
  // entrevistar: the form's questions (#225).
  preguntas?: InterviewQuestion[];
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// What the agent wrote. A small change without what the prototype needs or
// past the prototypes allowed, an error without its steps or past the
// reproductions allowed, a question past the limit, or an interview without
// usable questions or past its rounds, goes to the team: never left
// half-decided.
export function parsePortalResult(raw: string, questionsAsked: number, prototypesShown = 0, reproductions = 0, interviewRounds = 0): PortalResult {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('el resultado no es un objeto JSON');
  const r = parsed as Record<string, unknown>;
  const mensaje = text(r.mensaje, MAX_MESSAGE);
  if (!mensaje) throw new Error('el resultado no trae "mensaje"');
  if (!ACTIONS.includes(r.accion as PortalAction)) throw new Error(`"accion" inválida: ${String(r.accion)}`);
  const result: PortalResult = { accion: r.accion as PortalAction, mensaje };
  for (const [key, max] of [['titulo', TITLE_MAX], ['propuesta', MAX_FIELD], ['instruccion', MAX_FIELD], ['motivo', MAX_FIELD], ['resumen', MAX_FIELD], ['pasos', MAX_FIELD]] as const) {
    const value = text(r[key], max);
    if (value) result[key] = value;
  }
  if (result.accion === 'menor' && (!result.propuesta || !result.instruccion)) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'No quedó claro qué cambiar.' };
  }
  if (result.accion === 'menor' && prototypesShown >= MAX_PROTOTYPES) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'Pidió más ajustes de los que se pueden hacer aquí.', mensaje: 'Para dejarlo como lo necesitas hace falta que lo vea el equipo.' };
  }
  if (result.accion === 'error' && !result.pasos) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'No quedó claro cómo reproducir el error.' };
  }
  if (result.accion === 'error' && reproductions >= MAX_REPRODUCTIONS) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'No se pudo reproducir con datos de prueba.', mensaje: 'Para encontrar el error hace falta que lo vea el equipo de desarrollo.' };
  }
  if (result.accion === 'entrevistar') {
    const preguntas = parseQuestions(r.preguntas);
    if (!preguntas.length) return { ...result, accion: 'grande', motivo: result.motivo ?? 'No quedaron preguntas claras para la persona.' };
    if (interviewRounds >= MAX_ROUNDS) return { ...result, accion: 'grande', mensaje: 'Gracias por tus respuestas: con esto el equipo tiene lo que necesita para empezar.' };
    result.preguntas = preguntas;
  }
  if (result.accion === 'preguntar' && questionsAsked >= MAX_QUESTIONS) {
    return { ...result, accion: 'grande', motivo: result.motivo ?? 'Hicieron falta más datos de los que se pueden pedir aquí.', mensaje: 'Para entender bien lo que necesitas hace falta conversarlo con el equipo.' };
  }
  return result;
}

export const NEXT_STEP: Record<'menor' | 'otra' | 'error' | 'grande' | 'entrevistado', string> = {
  menor: 'Voy a armar un prototipo para que veas cómo quedaría antes de hacer el cambio. Te aviso aquí y por correo cuando esté listo.',
  otra: 'Voy a armar otro prototipo con tus ajustes. Te aviso aquí y por correo cuando esté listo.',
  error: 'Voy a intentar reproducirlo en una copia de la aplicación para ver qué pasa. Te aviso aquí y por correo.',
  grande: 'Se lo envié al equipo de desarrollo con tu descripción y tus imágenes. Te aviso por correo cuando esté resuelto.',
  entrevistado: 'Se lo envié al equipo de desarrollo con tu pedido, tus respuestas y tus imágenes. Te aviso por correo cuando esté resuelto.',
};

// The reply the person sees, and where the request goes.
export function applyResult(request: PortalRequest, result: PortalResult, now = new Date()): void {
  if (result.titulo && request.messages.filter((m) => m.from === 'ronin').length === 0) request.title = result.titulo;
  delete request.worker;
  // An answer about the prototype on screen leaves it there to decide on.
  const onScreen = (request.prototypes?.length ?? 0) > 0 && request.verdict?.kind === 'minor';
  if (result.accion === 'preguntar' || result.accion === 'responder') {
    addRoninMessage(request, result.mensaje, now);
    request.status = result.accion === 'preguntar' ? 'asking' : onScreen ? 'proposed' : 'answered';
    if (result.accion === 'preguntar') request.questions += 1;
    return;
  }
  if (result.accion === 'entrevistar') {
    // Big already: if the person skips the questions, it goes to the team
    // with this.
    request.verdict = { kind: 'big', summary: result.resumen ?? request.verdict?.summary ?? '', at: now.toISOString(), ...(result.motivo ? { reason: result.motivo } : {}) };
    const interview = (request.interview ??= { rounds: 0, corrections: 0 });
    interview.rounds += 1;
    request.status = 'interviewing';
    const id = addRoninMessage(request, result.mensaje, now);
    request.messages.find((m) => m.id === id)!.questions = result.preguntas;
    addEvent(request, { kind: 'interview', step: 'asked', round: interview.rounds }, now);
    return;
  }
  if (result.accion === 'error') {
    request.verdict = { kind: 'error', summary: result.resumen ?? '', at: now.toISOString() };
    // Asked again after a try: the earlier tries stay.
    request.bug = { steps: result.pasos ?? '', reproductions: request.bug?.reproductions ?? [] };
    request.status = 'reproducing';
    addEvent(request, { kind: 'classified', verdict: 'error' }, now);
    addRoninMessage(request, `${result.mensaje}\n\n${NEXT_STEP.error}`, now);
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
  addEvent(request, { kind: 'classified', verdict: kind }, now);
  const proposal = kind === 'minor' ? `\n\nLa propuesta: ${result.propuesta}` : '';
  const next = kind === 'big' ? (request.interview?.rounds ? NEXT_STEP.entrevistado : NEXT_STEP.grande) : request.prototypes?.length ? NEXT_STEP.otra : NEXT_STEP.menor;
  addRoninMessage(request, `${result.mensaje}${proposal}\n\n${next}`, now);
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

// The person hears back by email (they may have closed the page), except
// for a small change or an error: the next email is the prototype's, or the
// reproduction's. A big one's issue
// for the team comes next, in the same worker.
async function notify(request: PortalRequest, user: PortalUser | undefined): Promise<void> {
  if (request.status === 'big') await handOverMail(request, user);
  else if (request.status === 'interviewing') {
    if (user) await sendPortalMails(request, [interviewMail(request, user, config.portal.url)]);
  }
  else if (request.status !== 'minor' && request.status !== 'reproducing' && user) await sendPortalMails(request, [replyMail(request, user, config.portal.url)]);
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
    await runAgentTask(portalTask({
      type: 'portal-request',
      requestNumber: n,
      appName: request.app,
      conversation: request.messages.map((m) => ({ from: m.from, text: interviewText(m), images: m.images.map((file) => requestImagePath(n, file)) })),
      questionsLeft: Math.max(0, MAX_QUESTIONS - request.questions),
      interviewRoundsLeft: Math.max(0, MAX_ROUNDS - (request.interview?.rounds ?? 0)),
      interviewed: (request.interview?.rounds ?? 0) > 0,
      prototypes: request.prototypes?.length ?? 0,
      ...(request.verdict?.instruction ? { instruction: request.verdict.instruction } : {}),
      adjustmentsLeft: Math.max(0, MAX_PROTOTYPES - (request.prototypes?.length ?? 0)),
      ...(request.bug ? { reproductions: request.bug.reproductions.map((t) => ({ reproduced: t.reproduced, summary: t.summary })) } : {}),
      reproductionsLeft: Math.max(0, MAX_REPRODUCTIONS - (request.bug?.reproductions.length ?? 0)),
      checkoutDir: dir,
      outputPath,
    }));
    const result = parsePortalResult(await readFile(outputPath, 'utf8'), request.questions, request.prototypes?.length ?? 0, request.bug?.reproductions.length ?? 0, request.interview?.rounds ?? 0);
    const updated = await updateUnlessCancelled(n, (r) => applyResult(r, result));
    if (!updated) {
      log.info(`portal: el pedido P-${n} se canceló mientras ronin lo leía`);
      return;
    }
    log.info(`portal: pedido P-${n} → ${result.accion}`);
    await notify(updated, await getUser(updated.userId));
  } catch (error) {
    log.error(`portal: no se pudo revisar el pedido P-${n}`, error);
    try {
      const failed = await updateUnlessCancelled(n, (r) => {
        addEvent(r, { kind: 'failed', step: 'classify', error: errorLine(error) });
        addRoninMessage(r, FAILED_REPLY);
        // The prototype on screen, if any, is still there to decide on.
        r.status = r.prototypes?.length && r.verdict?.kind === 'minor' ? 'proposed' : 'asking';
        delete r.worker;
      });
      if (failed) await notify(failed, await getUser(failed.userId));
    } catch (e) {
      log.error(`portal: no se pudo guardar la falla del pedido P-${n}`, e);
    }
  } finally {
    if (dir) await removeWorktreeDir(dir, 'portal').catch(() => {});
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
