import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';
import type { Session } from '../../apps/api/http/auth.js';
import type { ExplorationPr, ExplorationReview, Ficha } from './review.js';
import { approvePr, commentOnFile, commentOnIssue, type Posted } from '../../platform/github/github-as-user.js';

// Deciding on a finding from the dashboard (#93): a comment on its file in
// the exploration PR, written as whoever is logged in — what they'd write in
// "Files changed". domains/explorations/flow.ts reads it like any other comment on a
// finding (pendingFeedback) and classifies it: reject, edit (and redo the
// after), open an issue, answer. So the comment says what it asks for in
// plain words, and needs no mention: a new comment on a finding is feedback.

export type FichaActionId = 'rechazar' | 'cambios' | 'issue' | 'pregunta' | 'comentar';
const ACTIONS: FichaActionId[] = ['rechazar', 'cambios', 'issue', 'pregunta', 'comentar'];
// On a finding already decided there's only talking left.
const ON_DECIDED: FichaActionId[] = ['pregunta', 'comentar'];
const MAX_TEXT = 4000;

// A 409: the item isn't in a state for it.
export class FichaActionError extends Error {
  readonly status = 409;
}

export function fichaComment(action: FichaActionId, text: string, redo = false): string {
  switch (action) {
    case 'rechazar': return `Rechazo esta ficha: ${text}`;
    case 'cambios': return redo ? `${text}\n\nTambién hay que rehacer la captura del después.` : text;
    case 'issue': return `Abrí un issue aparte: ${text}`;
    default: return text;
  }
}

export interface FichaActionRequest {
  action?: unknown;
  ficha?: unknown;
  text?: unknown;
  redo?: unknown;
}

export async function runFichaAction(
  entry: RepoEntry,
  pr: ExplorationPr,
  review: ExplorationReview,
  session: Session,
  request: FichaActionRequest,
  post: (token: string, repo: string, prNumber: number, path: string, body: string) => Promise<Posted> = commentOnFile,
): Promise<Posted & { ficha: string }> {
  const action = ACTIONS.find((a) => a === request.action);
  if (!action) throw new FichaActionError('Esa acción no existe.');
  const ficha: Ficha | undefined = review.fichas.find((f) => `${f.app}/${f.id}` === request.ficha);
  if (!ficha) throw new FichaActionError('Esa ficha no está en este PR.');
  if ((ficha.estado === 'rechazado' || ficha.estado === 'aprobado') && !ON_DECIDED.includes(action)) throw new FichaActionError(`${ficha.id} ya está ${ficha.estado === 'rechazado' ? 'rechazada' : 'aprobada'}: solo se puede comentar.`);
  const text = typeof request.text === 'string' ? request.text.trim().slice(0, MAX_TEXT) : '';
  if (!text) throw new FichaActionError('Falta el texto.');
  if (request.redo === true && action !== 'cambios') throw new FichaActionError('Rehacer el después va con "Pedir cambios".');
  const posted = await post(session.token, entry.productRepo, pr.number, ficha.path, fichaComment(action, text, request.redo === true));
  log.info(`tablero: ${session.login} comentó ${action} en ${ficha.id} de ${entry.productRepo}#${pr.number} (${posted.url})`);
  return { ...posted, ficha: `${ficha.app}/${ficha.id}` };
}

// A general comment on the PR: about several findings at once ("los de
// mobile se resuelven con F-0003") or what the next explorations should
// leave alone. pendingGeneralFeedback only reads those that mention ronin.
export function generalComment(text: string): string {
  return `@${config.githubLogin} ${text}`;
}

export async function runGeneralComment(
  entry: RepoEntry,
  pr: ExplorationPr,
  session: Session,
  request: { text?: unknown },
  post: (token: string, repo: string, number: number, body: string) => Promise<Posted> = commentOnIssue,
): Promise<Posted> {
  const text = typeof request.text === 'string' ? request.text.trim().slice(0, MAX_TEXT) : '';
  if (!text) throw new FichaActionError('Falta el texto.');
  const posted = await post(session.token, entry.productRepo, pr.number, generalComment(text));
  log.info(`tablero: ${session.login} dejó un comentario general en ${entry.productRepo}#${pr.number} (${posted.url})`);
  return posted;
}

// The findings with a comment ronin hasn't applied yet: a new one on the
// finding, or a reply that mentions it, with nothing from ronin after.
export function waitingOnRonin(review: ExplorationReview, ronin = config.githubLogin): Ficha[] {
  const mention = new RegExp(`@${ronin}\\b`, 'i');
  return review.fichas.filter((f) => {
    if (f.estado !== 'propuesto') return false;
    const last = f.comments[f.comments.length - 1];
    return Boolean(last && last.author.toLowerCase() !== ronin.toLowerCase() && (!last.replyTo || mention.test(last.body)));
  });
}

// Approving the PR, as the person: an APPROVE review. From there it's
// ronin's usual gate (domains/explorations/flow.ts's approveAndMerge): the findings
// still standing are approved, get their issue, and the PR merges. Not
// while ronin is still applying a comment, which could reject one of them.
export async function runApprove(
  entry: RepoEntry,
  pr: ExplorationPr,
  review: ExplorationReview,
  session: Session,
  request: { text?: unknown },
  approve: (token: string, repo: string, prNumber: number, body?: string) => Promise<Posted> = approvePr,
): Promise<Posted> {
  const waiting = waitingOnRonin(review);
  if (waiting.length > 0) throw new FichaActionError(`ronin todavía está aplicando comentarios en ${waiting.map((f) => f.id).join(', ')}. Aprobá cuando responda.`);
  const text = typeof request.text === 'string' ? request.text.trim().slice(0, MAX_TEXT) : '';
  const posted = await approve(session.token, entry.productRepo, pr.number, text || undefined);
  log.info(`tablero: ${session.login} aprobó ${entry.productRepo}#${pr.number} (${posted.url})`);
  return posted;
}
