import { log } from '@platform/logger.js';
import { getUser } from './accounts.js';
import type { ImageUpload } from './images.js';
import { launchPortalWorker } from './launch.js';
import { handOverMail } from './notify.js';
import { addEvent, addRoninMessage, nextMessageId, RequestError, saveImages, updateRequest, type InterviewAnswer, type InterviewQuestion, type PortalMessage, type PortalRequest, type Understood } from './requests.js';

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
export async function confirmUnderstood(n: number, ok: boolean, text: string, images: ImageUpload[] = [], launch = launchPortalWorker, now = new Date()): Promise<PortalRequest> {
  if (ok) return handOver(n, 'confirmed', now, launch);
  if (!text.trim()) throw new RequestError('Escribe qué entendió mal ronin o qué falta.');
  const corrected = await updateRequest(n, async (r) => {
    if (r.status !== 'confirming') throw new RequestError('Este pedido no espera tu confirmación ahora.');
    const interview = (r.interview ??= { rounds: 0, corrections: 0 });
    if (interview.corrections >= MAX_CORRECTIONS) throw new RequestError('Ya no quedan correcciones: envíalo al equipo como está y diles ahí lo que falte.');
    interview.corrections += 1;
    const id = nextMessageId(r);
    r.messages.push({ id, from: 'person', text: text.trim(), images: await saveImages(n, id, images), correction: true, at: now.toISOString() });
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

const MAX_QUESTION = 300;
const MAX_OPTION = 200;
const MAX_OPTIONS = 6;
const KINDS = { una: 'one', varias: 'many', texto: 'text' } as const;

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// The questions the agent wrote ("entrevistar"), as the portal shows them:
// at most MAX_INTERVIEW_QUESTIONS, the first ones; a question without its
// text, or with options but fewer than two, is left out. Ids are the
// agent's when they're usable, unique either way.
export function parseQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: InterviewQuestion[] = [];
  for (const item of raw) {
    if (questions.length >= MAX_INTERVIEW_QUESTIONS) break;
    if (typeof item !== 'object' || item === null) continue;
    const q = item as Record<string, unknown>;
    const text = clean(q.pregunta, MAX_QUESTION);
    const kind = KINDS[q.tipo as keyof typeof KINDS];
    if (!text || !kind) continue;
    const question: InterviewQuestion = { id: '', kind, text };
    const help = clean(q.ayuda, MAX_QUESTION);
    if (help) question.help = help;
    if (kind === 'text') {
      const example = clean(q.ejemplo, MAX_QUESTION);
      if (example) question.example = example;
    } else {
      const options = [...new Set((Array.isArray(q.opciones) ? q.opciones : []).map((o) => clean(o, MAX_OPTION)).filter((o): o is string => Boolean(o)))].slice(0, MAX_OPTIONS);
      if (options.length < 2) continue;
      question.options = options;
      if (q.otra === true) question.other = true;
    }
    if (q.opcional === true) question.optional = true;
    const wanted = typeof q.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(q.id) ? q.id : `p${questions.length + 1}`;
    let id = wanted;
    for (let i = 2; questions.some((x) => x.id === id); i++) id = `${wanted}-${i}`;
    question.id = id;
    questions.push(question);
  }
  return questions;
}

// A message of the interview as the agent reads it in the conversation: the
// questions it left, or the person's answers in words.
export function interviewText(m: Pick<PortalMessage, 'text' | 'questions' | 'answers' | 'understood' | 'skipped' | 'confirmed'>): string {
  if (m.questions) {
    const form = m.questions.map((q, i) => `${i + 1}. ${q.text}${q.options ? ` (options: ${q.options.join(' | ')}${q.other ? ' | Otra' : ''})` : ' (free text)'}${q.optional ? ' (optional)' : ''}`).join('\n');
    return `${m.text}\n\n[The form you left them:]\n${form}`;
  }
  if (m.answers) {
    const answers = m.answers.map((a) => `- ${a.question} → ${a.answer}`).join('\n');
    return `[Their answers to your form:]\n${answers}${m.text ? `\n\n[Anything else they added:] ${m.text}` : ''}`;
  }
  if (m.understood) {
    const u = m.understood;
    return [
      m.text,
      '[The summary you showed them:]',
      ...u.decisions.map((d) => `- ${d.topic}: ${d.decision}`),
      ...(u.out.length ? [`Left out: ${u.out.join('; ')}`] : []),
      ...(u.team.length ? [`For the team to decide: ${u.team.join('; ')}`] : []),
    ].join('\n');
  }
  if (m.skipped) return '[They sent it to the team without answering.]';
  if (m.confirmed) return '[They confirmed your summary.]';
  return m.text;
}

const MAX_DECISIONS = 12;
const MAX_TOPIC = 80;
const MAX_DECISION = 500;

// What ronin understood after the interview ("entendido", with "grande"):
// each decision as topic → decision, what's left out and what the team
// decides. Undefined without a single decision: then it goes to the team
// without asking the person to confirm anything.
export function parseUnderstood(raw: unknown): Understood | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const decisions = (Array.isArray(r.decisiones) ? r.decisiones : [])
    .map((d) => (typeof d === 'object' && d !== null ? { topic: clean((d as Record<string, unknown>).tema, MAX_TOPIC), decision: clean((d as Record<string, unknown>).decision, MAX_DECISION) } : {}))
    .filter((d): d is { topic: string; decision: string } => Boolean(d.topic && d.decision))
    .slice(0, MAX_DECISIONS);
  if (!decisions.length) return undefined;
  const list = (value: unknown) => (Array.isArray(value) ? value.map((v) => clean(v, MAX_DECISION)).filter((v): v is string => Boolean(v)).slice(0, MAX_DECISIONS) : []);
  return { decisions, out: list(r.fuera), team: list(r.equipo) };
}

// What the interview left for the team: each round's answers, the last
// summary, and how it ended. Undefined when ronin never interviewed them.
export interface InterviewRecord {
  ended: 'confirmed' | 'skipped' | 'answered';
  rounds: InterviewAnswer[][];
  understood?: Understood;
}

export function interviewRecord(r: Pick<PortalRequest, 'interview' | 'messages'>): InterviewRecord | undefined {
  if (!r.interview?.rounds) return undefined;
  const rounds = r.messages.filter((m) => m.answers?.length).map((m) => m.answers!);
  const understood = r.messages.filter((m) => m.understood).at(-1)?.understood;
  const ended = r.interview.confirmed ? 'confirmed' : r.interview.skipped || !rounds.length ? 'skipped' : 'answered';
  return { ended, rounds, ...(understood && ended !== 'skipped' ? { understood } : {}) };
}
