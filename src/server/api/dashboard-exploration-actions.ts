import { log } from '../../core/logger.js';
import type { RepoEntry } from '../../core/repo-context.js';
import type { Session } from './auth.js';
import type { ExplorationPr, ExplorationReview, Ficha } from './dashboard-exploration.js';
import { commentOnFile, type Posted } from './github-as-user.js';

// Deciding on a finding from the dashboard (#93): a comment on its file in
// the exploration PR, written as whoever is logged in — what they'd write in
// "Files changed". exploration/flow.ts reads it like any other comment on a
// finding (pendingFeedback) and classifies it: reject, edit (and redo the
// after), open an issue, answer. So the comment says what it asks for in
// plain words, and needs no mention: a new comment on a finding is feedback.

export type FichaActionId = 'rechazar' | 'cambios' | 'issue' | 'pregunta' | 'comentar';
const ACTIONS: FichaActionId[] = ['rechazar', 'cambios', 'issue', 'pregunta', 'comentar'];
// On a finding already decided there's only talking left.
const ON_DECIDED: FichaActionId[] = ['pregunta', 'comentar'];
const MAX_TEXT = 4000;

export class FichaActionError extends Error {}

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
