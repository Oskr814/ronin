import { log } from '../core/logger.js';
import { getUser } from './accounts.js';
import type { ImageUpload } from './images.js';
import { launchPortalWorker } from './launch.js';
import { handOverMail } from './notify.js';
import { addEvent, addRoninMessage, nextMessageId, RequestError, saveImages, updateRequest, type InterviewAnswer, type InterviewQuestion, type PortalRequest } from './requests.js';

// The interview (#225): before a big request goes to the team, ronin asks
// the person what the team would otherwise have to ask them, in a form —
// one round, maybe two — and then shows them what it understood, for them
// to confirm or correct. The agent chooses the questions and how many; the
// limits are here.

export const MAX_ROUNDS = 2;
export const MAX_INTERVIEW_QUESTIONS = 5;
export const MAX_CORRECTIONS = 2;
const MAX_OTHER = 300;
const MAX_TEXT = 1000;

export const UNSURE = 'No sé, que lo decida el equipo';

export const SKIPPED_REPLY = 'Se lo envié al equipo de desarrollo con tu pedido y tus imágenes. Si les falta algo, te lo preguntan. Te aviso por correo cuando esté resuelto.';
export const CONFIRMED_REPLY = 'Se lo envié al equipo de desarrollo con tu pedido, tus respuestas y tus imágenes. Te aviso por correo cuando esté resuelto.';

// The questions waiting on the person: ronin's last message's, while the
// request is 'interviewing'.
export function openQuestions(r: Pick<PortalRequest, 'status' | 'messages'>): InterviewQuestion[] {
  if (r.status !== 'interviewing') return [];
  return r.messages.filter((m) => m.from === 'ronin').at(-1)?.questions ?? [];
}

// What the portal sends for one question: the options picked (their
// indexes), the text of "Otra", the text of a text question, or "No sé".
export interface AnswerInput {
  id: string;
  choices?: number[];
  other?: string;
  text?: string;
  unsure?: boolean;
}

const str = (value: unknown, max: number, what: string): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new RequestError(`${what} no llegó bien.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new RequestError(`${what} puede tener hasta ${max} caracteres.`);
  return trimmed;
};

// The answers in words, checked against the questions: every option exists,
// "Otra" only where offered, and every question that isn't optional has an
// answer. The person never writes the words of an option, so an answer
// can't say what the question didn't offer.
export function readAnswers(questions: InterviewQuestion[], raw: unknown): InterviewAnswer[] {
  if (!Array.isArray(raw)) throw new RequestError('Las respuestas no llegaron bien.');
  const given = new Map<string, Record<string, unknown>>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'string') throw new RequestError('Las respuestas no llegaron bien.');
    const id = (item as { id: string }).id;
    if (!questions.some((q) => q.id === id)) throw new RequestError('Una respuesta no corresponde a ninguna pregunta.');
    given.set(id, item as Record<string, unknown>);
  }
  const answers: InterviewAnswer[] = [];
  for (const q of questions) {
    const a = given.get(q.id);
    const answer = a ? answerOf(q, a) : undefined;
    if (answer) answers.push(answer);
    else if (!q.optional) throw new RequestError(`Falta responder: «${q.text}». Si no sabes, marca «No sé».`);
  }
  return answers;
}

function answerOf(q: InterviewQuestion, a: Record<string, unknown>): InterviewAnswer | undefined {
  const base = { id: q.id, question: q.text };
  if (a.unsure === true) return { ...base, answer: UNSURE, unsure: true };
  if (q.kind === 'text') {
    const text = str(a.text, MAX_TEXT, 'La respuesta');
    return text ? { ...base, answer: text } : undefined;
  }
  const choices = a.choices ?? [];
  const options = q.options ?? [];
  if (!Array.isArray(choices) || choices.some((c) => !Number.isInteger(c) || c < 0 || c >= options.length)) throw new RequestError('Una opción elegida no existe.');
  const other = str(a.other, MAX_OTHER, 'Lo que escribiste en «Otra»');
  if (other && !q.other) throw new RequestError('Esa pregunta no acepta otra respuesta.');
  const picked = [...new Set(choices as number[])].sort((x, y) => x - y).map((c) => options[c]);
  if (other) picked.push(`Otra: ${other}`);
  if (!picked.length) return undefined;
  if (q.kind === 'one' && picked.length > 1) throw new RequestError(`Elige solo una respuesta en «${q.text}».`);
  return { ...base, answer: picked.join(' · ') };
}

// The person's answers to the questions on screen, with an optional note
// and images: ronin reads them next.
export async function answerInterview(n: number, input: { answers: unknown; note: string; images: ImageUpload[] }, launch = launchPortalWorker, now = new Date()): Promise<PortalRequest> {
  const answered = await updateRequest(n, async (r) => {
    const questions = openQuestions(r);
    if (!questions.length) throw new RequestError('Este pedido no espera respuestas ahora.');
    const answers = readAnswers(questions, input.answers);
    const id = nextMessageId(r);
    r.messages.push({ id, from: 'person', text: input.note.trim(), images: await saveImages(n, id, input.images), answers, at: now.toISOString() });
    addEvent(r, { kind: 'interview', step: 'answered', round: r.interview?.rounds ?? 1 }, now);
    r.status = 'thinking';
    delete r.worker;
    return r;
  });
  await launch(n);
  return answered;
}

// To the team as it is: without answering, or without confirming the
// summary.
export async function skipInterview(n: number, launch = launchPortalWorker, now = new Date()): Promise<PortalRequest> {
  return handOver(n, 'skipped', now, launch);
}

// The summary on screen: right ("ok"), it goes to the team; or what ronin
// got wrong, and ronin writes it again.
export async function confirmUnderstood(n: number, ok: boolean, text: string, launch = launchPortalWorker, now = new Date()): Promise<PortalRequest> {
  if (ok) return handOver(n, 'confirmed', now, launch);
  if (!text.trim()) throw new RequestError('Escribe qué entendió mal ronin o qué falta.');
  const corrected = await updateRequest(n, (r) => {
    if (r.status !== 'confirming') throw new RequestError('Este pedido no espera tu confirmación ahora.');
    const interview = (r.interview ??= { rounds: 0, corrections: 0 });
    if (interview.corrections >= MAX_CORRECTIONS) throw new RequestError('Ya no quedan correcciones: envíalo al equipo como está y diles ahí lo que falte.');
    interview.corrections += 1;
    r.messages.push({ id: nextMessageId(r), from: 'person', text: text.trim(), images: [], at: now.toISOString() });
    addEvent(r, { kind: 'interview', step: 'corrected', round: interview.corrections }, now);
    r.status = 'thinking';
    delete r.worker;
    return r;
  });
  await launch(n);
  return corrected;
}

async function handOver(n: number, how: 'skipped' | 'confirmed', now: Date, launch: (n: number) => Promise<void>): Promise<PortalRequest> {
  const handed = await updateRequest(n, (r) => {
    if (how === 'skipped' ? r.status !== 'interviewing' && r.status !== 'confirming' : r.status !== 'confirming') {
      throw new RequestError(how === 'skipped' ? 'Este pedido no espera respuestas ahora.' : 'Este pedido no espera tu confirmación ahora.');
    }
    const interview = (r.interview ??= { rounds: 0, corrections: 0 });
    // Skipping the summary still keeps the answers: only skipping the
    // questions leaves the request as it came.
    if (how === 'confirmed') interview.confirmed = true;
    else if (r.status === 'interviewing') interview.skipped = true;
    r.messages.push({ id: nextMessageId(r), from: 'person', text: '', images: [], [how]: true, at: now.toISOString() });
    addEvent(r, { kind: 'interview', step: how, round: interview.rounds }, now);
    r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', at: now.toISOString() };
    r.status = 'big';
    addRoninMessage(r, how === 'confirmed' || !interview.skipped ? CONFIRMED_REPLY : SKIPPED_REPLY, now);
    delete r.worker;
    return r;
  });
  log.info(`portal: el pedido P-${n} pasó al equipo (${how === 'confirmed' ? 'confirmó lo que entendió ronin' : 'sin terminar la entrevista'})`);
  await handOverMail(handed, await getUser(handed.userId));
  await launch(n);
  return handed;
}
