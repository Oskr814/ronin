import { useQuery, type QueryClient } from '@tanstack/react-query';
import { ApiError, client, ok, type Exploration } from '@apps/dashboard/src/api.js';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { itemParam } from './model.js';

// An exploration PR's findings (#93), as its Fichas tab reviews them: read
// into their parts, with their threads. Approving or rejecting one is kept
// in ronin, shared at once with everyone reviewing it, and written into the
// PR when the review is finished (#446); without a database, rejecting is a
// comment on its file and approving is this browser's mark. The rest
// (changes, an issue, a question) is a comment ronin applies as any other.

export type FindingCard = Exploration['fichas'][number];
export type FindingDecision = NonNullable<Exploration['decisiones']>[number];
export type FindingImage = FindingCard['antes'][number];
export type FichaStatus = 'decidir' | 'esperando' | 'respondida' | 'lista' | 'aprobada' | 'rechazada';

const RONIN_MENTION = /@ronin-agent\b/i;
export const fichaKey = (f: FindingCard) => `${f.app}/${f.id}`;
export const FICHA_GROUPS: Array<[FichaStatus, string]> = [['decidir', 'Por decidir'], ['esperando', 'Esperando a ronin'], ['respondida', 'Respondidas por ronin'], ['lista', 'Listas para aprobar'], ['aprobada', 'Aprobadas'], ['rechazada', 'Rechazadas']];
export const FICHA_DOT: Record<FichaStatus, string> = { decidir: 'pending', esperando: 'live', respondida: 'run', lista: 'ok', aprobada: 'ok', rechazada: 'crit' };

// How often the findings are read again while the page is open: more often
// while one waits on ronin, to show its answer.
const DETAIL_EVERY_MS = 30_000;
const WAITING_EVERY_MS = 10_000;

// The PR's findings, read while its page is open (and only for an exploration PR).
export function useExploration(id: string, enabled: boolean) {
  const shell = useShell();
  return useQuery({
    queryKey: ['exploration', id],
    enabled,
    queryFn: async () => {
      try {
        return await ok(client.api.items[':id'].exploration.$get({ param: itemParam(id) }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) shell.unauthorized(e.message);
        throw e;
      }
    },
    refetchInterval: (q) => (q.state.data?.fichas.some((f) => fichaStatus(f, q.state.data!, id) === 'esperando') ? WAITING_EVERY_MS : DETAIL_EVERY_MS),
  });
}

// Without a database, "Aprobar" on a finding is this browser's mark of what
// was looked at, so the review's progress shows. The finding is approved
// for real when the PR is (approveAndMerge).
const listasKey = (id: string) => `ronin-listas:${id}`;
// Without storage, they last while the page is open.
const unstored = new Map<string, Set<string>>();
export function listas(id: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(listasKey(id)) ?? '[]') as string[]);
  } catch {
    return unstored.get(id) ?? new Set();
  }
}
export function setLista(id: string, key: string, on: boolean) {
  const set = listas(id);
  if (on) set.add(key);
  else set.delete(key);
  unstored.set(id, set);
  try { localStorage.setItem(listasKey(id), JSON.stringify([...set])); } catch { /* sin storage */ }
}

// The team's decision on it, kept in ronin and not yet written into the PR.
export const decisionOf = (data: Pick<Exploration, 'decisiones'>, f: FindingCard): FindingDecision | undefined => data.decisiones?.find((d) => d.ficha === fichaKey(f) && !d.applied);

// Where a finding stands: decided in its file or by the team in ronin, or by
// its thread — ronin answers a first comment, or a reply that mentions it.
// Once ronin answered (applied the changes asked for), it can be marked to
// approve again.
export function fichaStatus(f: FindingCard, data: Pick<Exploration, 'ronin' | 'decisiones'>, id?: string): FichaStatus {
  const { ronin } = data;
  if (f.estado === 'rechazado') return 'rechazada';
  if (f.estado === 'aprobado') return 'aprobada';
  const decided = decisionOf(data, f);
  if (decided?.decision === 'rechazar') return 'rechazada';
  const marked = data.decisiones ? decided?.decision === 'aprobar' : Boolean(id) && listas(id!).has(fichaKey(f));
  const last = f.comments[f.comments.length - 1];
  if (!last) return marked ? 'lista' : 'decidir';
  if (last.author !== ronin && (!last.replyTo || RONIN_MENTION.test(last.body))) return 'esperando';
  return marked ? 'lista' : 'respondida';
}

export interface FichaFilter {
  tipo: 'todas' | 'hallazgo' | 'idea';
  vp: 'todos' | 'desktop' | 'mobile';
}

export function visibleFichas(data: Exploration, id: string, filter: FichaFilter): FindingCard[] {
  const shown = data.fichas.filter((f) => (filter.tipo === 'todas' || f.tipo === filter.tipo) && (filter.vp === 'todos' || f.viewport === filter.vp));
  return FICHA_GROUPS.flatMap(([k]) => shown.filter((f) => fichaStatus(f, data, id) === k));
}

export const waitingCount = (data: Exploration | undefined, id: string) => (data ? data.fichas.filter((f) => fichaStatus(f, data, id) === 'esperando').length : 0);

// Approving or rejecting a finding in ronin (#446), or taking it back
// (null): on the page at once, as decided by the person, and the server's
// list after. If it doesn't go, the page goes back to what it had.
export async function postDecision(queryClient: QueryClient, id: string, ficha: string, decision: 'aprobar' | 'rechazar' | null, by: string, text?: string): Promise<void> {
  const key = ['exploration', id];
  // A read already on its way would bring back what was there before.
  await queryClient.cancelQueries({ queryKey: key });
  const before = queryClient.getQueryData<Exploration>(key);
  const others = (before?.decisiones ?? []).filter((d) => d.ficha !== ficha);
  if (before) queryClient.setQueryData<Exploration>(key, { ...before, decisiones: decision ? [...others, { ficha, decision, reason: text ?? null, by, at: new Date().toISOString(), applied: false }] : others });
  try {
    const done = (await ok(client.api.items[':id'].exploration.decision.$post({ param: itemParam(id), json: { ficha, decision, ...(text ? { text } : {}) } }))) as { decisiones: FindingDecision[] };
    queryClient.setQueryData<Exploration>(key, (now) => now && { ...now, decisiones: done.decisiones });
  } catch (error) {
    if (before) queryClient.setQueryData<Exploration>(key, (now) => now && { ...now, decisiones: before.decisiones });
    throw error;
  }
}

// What a finding's dialog does: on the finding (a comment on its file), or
// on the whole PR.
export type FichaActionId = 'rechazar' | 'cambios' | 'issue' | 'desarrollar' | 'pregunta' | 'general' | 'approve';
export const FICHA_ACTIONS: Record<FichaActionId, { title: string; field: string; btn: string; placeholder: string; cls?: 'danger'; quick?: string[]; redo?: boolean; pr?: boolean; optional?: boolean }> = {
  rechazar: { title: 'Rechazar', field: 'Motivo: queda en knowledge.md para que no se vuelva a proponer', btn: 'Rechazar', cls: 'danger', placeholder: 'Por qué no va', quick: ['Muy poco probable: es una app interna con pocos usuarios', 'Ya está cubierto', 'No es un problema para el equipo', 'Lo resolvemos con otra ficha'] },
  cambios: { title: 'Pedir cambios', field: 'Qué cambiar en la propuesta', btn: 'Pedir cambios', placeholder: 'Por ejemplo: que el aviso diga “No se encontró el producto o ya fue eliminado por otro usuario”', redo: true },
  issue: { title: 'Pedir un issue aparte', field: 'Qué tiene que tener el issue', btn: 'Pedir el issue', placeholder: 'Por ejemplo: revisar todos los toasts de error de catálogos' },
  // Its own issue now, before the PR is approved (#379).
  desarrollar: { optional: true, title: 'Desarrollar ya', field: 'Contexto para el issue (opcional)', btn: 'Mandar a desarrollar', placeholder: 'Por ejemplo: es urgente, lo reportó un cliente esta semana' },
  pregunta: { title: 'Preguntarle a ronin', field: 'Tu pregunta', btn: 'Preguntar', placeholder: '¿Esto pasa también como Sales?' },
  // On the whole PR, not a finding.
  general: { pr: true, title: 'Comentario general', field: 'Sobre varias fichas a la vez, o lo que las próximas exploraciones no deben volver a proponer', btn: 'Comentar', placeholder: 'Por ejemplo: F-0017 y F-0018 no aplican, el listado de catálogos lo usa una sola persona' },
  approve: { pr: true, optional: true, title: 'Finalizar la revisión', field: 'Comentario de la review (opcional)', btn: 'Finalizar', placeholder: 'Por ejemplo: las de catálogos van primero' },
};

// The comment as it will be written — the same words the server writes
// (explorations/review-actions.ts's findingCardComment).
export function fichaCommentText(action: string, text: string, redo: boolean): string {
  if (action === 'rechazar') return `Rechazo esta ficha: ${text}`;
  if (action === 'cambios') return redo ? `${text}\n\nTambién hay que rehacer la captura del después.` : text;
  if (action === 'issue') return `Abrí un issue aparte: ${text}`;
  if (action === 'desarrollar') return text ? `Desarrollar ya: ${text}` : 'Desarrollar ya.';
  return text;
}

// A dialog asked for: on a finding (its key, id and title) or on the PR.
export interface FichaAsked {
  action: FichaActionId;
  ficha?: { key: string; id: string; titulo: string };
  redo?: boolean;
}

// Sends a comment on the finding (from the dialog, or the box under its
// thread); the findings are read again, so it shows it's waiting on ronin.
export async function postFichaComment(id: string, ficha: string, action: string, text: string, redo: boolean): Promise<{ url?: string }> {
  // A refusal makes the client's type of the answer {}: it's written here.
  const done = (await ok(client.api.items[':id'].exploration[':what{actions|general|approve}'].$post({ param: { ...itemParam(id), what: 'actions' }, json: { action, ficha, text, ...(redo ? { redo: true } : {}) } }))) as { url?: string };
  setLista(id, ficha, false);
  return done;
}

// The general comment and the approval, on the whole PR.
export async function postPrDecision(id: string, what: 'general' | 'approve', text: string): Promise<{ url?: string }> {
  return (await ok(client.api.items[':id'].exploration[':what{actions|general|approve}'].$post({ param: { ...itemParam(id), what }, json: text ? { text } : {} }))) as { url?: string };
}
