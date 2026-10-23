import type { ReactNode } from 'react';
import type { RequestDetail, RequestRow } from '@apps/dashboard/src/api.js';

// What the list and a request's page share: the states, the steps a request
// goes through and who it waits on, written as the portal's people and the
// team read them.

export type Detail = RequestDetail;
export type Row = RequestRow;
export type Message = Detail['messages'][number];
export type Entry = Detail['activity']['entries'][number];
export type RequestEvent = Detail['activity']['untimed'][number];
export type Reproduction = NonNullable<Detail['bug']>['reproductions'][number];

// Read again every ten seconds, as the tablero did (PEDIDO_EVERY_MS).
export const EVERY_MS = 10_000;

export const STATUS: Record<string, [string, string]> = {
  thinking: ['run', 'ronin lo está leyendo'], asking: ['warn', 'Espera a la persona'], answered: ['idle', 'Respondido'],
  interviewing: ['warn', 'Espera sus respuestas'], confirming: ['warn', 'Espera que confirme'],
  minor: ['run', 'Armando el prototipo'], proposed: ['warn', 'Espera que apruebe'], 'awaiting-dev': ['decide', 'Decidir si se hace'], approved: ['run', 'Aprobado'],
  reproducing: ['run', 'Reproduciendo el error'], fixing: ['run', 'En corrección'],
  done: ['ok', 'Listo'], resolved: ['ok', 'Resuelto por el equipo'], declined: ['idle', 'No se hará'],
  cancelled: ['idle', 'Cancelado'], big: ['warn', 'En el equipo'],
};
export const CLOSED = ['done', 'resolved', 'declined', 'cancelled'];
// A reported error's tries at reproducing it (#137), and how many it gets.
export const REPRODUCTIONS = 2;

export { ICON } from '@apps/dashboard/src/lib/icons.js';

export const imagePath = (n: number, file: string) => `/api/requests/${n}/img/${encodeURIComponent(file)}`;
export const firstName = (name: string | null | undefined) => String(name ?? '').split(' ')[0];
export { repoShort } from '@apps/dashboard/src/lib/format.js';
const safeRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);
export const issueUrl = (repo: string, number: number) => (safeRepo(repo) ? `https://github.com/${repo}/issues/${number}` : null);
export const prUrl = (repo: string, number: number) => (safeRepo(repo) ? `https://github.com/${repo}/pull/${number}` : null);

// `mine`: the one looking at it can decide it (#406).
export function waitsLabel(p: Row, mine = false): string {
  const who = firstName(p.person);
  if (p.personReplied) return `${who} respondió: leerlo`;
  switch (p.waitsOn) {
    case 'person': return p.status === 'proposed' ? `${who}: aprobar o ajustar` : p.status === 'interviewing' ? `${who}: responder las preguntas` : p.status === 'confirming' ? `${who}: confirmar el resumen` : `${who}: responder`;
    case 'ronin': return p.running ? 'ronin trabajando' : p.status === 'approved' && p.issue ? `ronin: el cambio en #${p.issue}` : p.status === 'fixing' && p.issue ? `ronin: el arreglo en #${p.issue}` : p.status === 'minor' ? 'ronin: el prototipo' : p.status === 'reproducing' ? 'ronin: reproducirlo' : p.status === 'thinking' ? 'ronin: leerlo' : 'ronin: abrir el issue';
    case 'team': return p.status === 'awaiting-dev' ? (mine ? 'Tú: aprobar o no hacerlo' : 'Un dev: decidir si se hace') : p.pr ? `Un dev: aprobar el PR #${p.pr}` : `El equipo: #${p.issue}`;
    default: return CLOSED.includes(p.status) ? 'Cerrado' : 'Nadie';
  }
}

// What the steps need of a request: a row has the verdict's kind and how
// many prototypes; a request's page, the verdict and the prototypes.
interface Staged {
  status: string;
  bug: unknown;
  issue?: unknown;
  pr?: number | null;
  verdict?: string | { kind: string } | null;
  prototypes: number | unknown[];
}
interface Stage { cur: number; tone: string; skip: number[]; labels: string[] }

// A reported error's six steps (#137): no prototype nor approval, its
// reproduction instead.
function bugStage(p: Staged): Stage {
  const big = p.status === 'big' || p.status === 'resolved';
  const labels = ['Pedido', 'Error', 'Reproducción', big ? 'Issue del equipo' : 'Issue', 'PR', big ? 'Resuelto' : 'Listo'];
  let cur;
  let tone = 'run';
  switch (p.status) {
    case 'thinking': case 'asking': case 'answered': cur = 1; tone = p.status === 'asking' ? 'warn' : p.status === 'answered' ? 'idle' : 'run'; break;
    case 'reproducing': cur = 2; break;
    case 'awaiting-dev': cur = 3; tone = 'warn'; labels[3] = 'Decisión del equipo'; break;
    case 'fixing': cur = p.pr ? 4 : 3; tone = p.pr ? 'warn' : 'run'; break;
    case 'big': cur = 3; tone = p.issue ? 'warn' : 'run'; break;
    case 'done': case 'resolved': cur = 6; break;
    case 'declined': cur = 5; tone = 'crit'; labels[5] = 'No se hará'; break;
    default: cur = p.issue ? 3 : 2; tone = 'idle'; labels[cur] = 'Cancelado';
  }
  return { cur, tone, skip: [], labels };
}

// The seven steps, which one it's on and how.
export function stage(p: Staged): Stage {
  if (p.bug) return bugStage(p);
  const verdict = typeof p.verdict === 'string' ? p.verdict : p.verdict?.kind;
  const prototypes = Array.isArray(p.prototypes) ? p.prototypes.length : p.prototypes;
  const big = p.status === 'big' || p.status === 'resolved' || verdict === 'big';
  const skip = big && !prototypes ? [2, 3] : [];
  const labels = ['Pedido', 'Conversación', 'Prototipo', 'Aprobación', big ? 'Issue del equipo' : 'Issue', 'PR', big ? 'Resuelto' : 'Listo'];
  let cur;
  let tone = 'run';
  switch (p.status) {
    case 'thinking': case 'asking': case 'answered': cur = 1; tone = p.status === 'asking' ? 'warn' : p.status === 'answered' ? 'idle' : 'run'; break;
    case 'interviewing': case 'confirming': cur = 1; tone = 'warn'; break;
    case 'minor': cur = 2; break;
    case 'proposed': cur = 3; tone = 'warn'; break;
    case 'awaiting-dev': cur = 3; tone = 'warn'; labels[3] = 'Decisión del equipo'; break;
    case 'approved': cur = p.pr ? 5 : 4; tone = p.pr ? 'warn' : 'run'; break;
    case 'big': cur = 4; tone = p.issue ? 'warn' : 'run'; break;
    case 'done': case 'resolved': cur = 7; break;
    case 'declined': cur = 6; tone = 'crit'; labels[6] = 'No se hará'; break;
    default: cur = p.issue ? 4 : prototypes ? 3 : 1; tone = 'idle'; labels[cur] = 'Cancelado';
  }
  return { cur, tone, skip, labels };
}

export function Mini({ p }: { p: Staged }) {
  const { cur, tone, skip, labels } = stage(p);
  return <span className="pd-mini" aria-hidden="true">{labels.map((_, i) => <i key={i} className={skip.includes(i) ? '' : i < cur ? 'ok' : i === cur ? tone : ''} />)}</span>;
}

export function Stepper({ p }: { p: Staged }) {
  const { cur, tone, skip, labels } = stage(p);
  return (
    <div className="pd-steps">{labels.map((label, i) => {
      const cls = skip.includes(i) ? 'skip' : i < cur ? 'ok' : i === cur ? tone : '';
      return [
        i ? <span key={`l${i}`} className={`ln ${i <= cur && !skip.includes(i) ? 'ok' : ''}`} /> : null,
        <span key={i} className={`st ${cls}`}><span className="b">{cls === 'ok' ? '✓' : i + 1}</span>{label}</span>,
      ];
    })}</div>
  );
}

export function StatusChip({ p }: { p: { status: string; pr?: number | null; bug?: unknown } }) {
  const [cls, label] = STATUS[p.status] ?? ['idle', p.status];
  return <span className={`chip ${cls}`}>{p.status === 'approved' && p.pr ? 'Aprobado · en un PR' : p.status === 'fixing' && p.pr ? 'En corrección · en un PR' : p.status === 'awaiting-dev' && p.bug ? 'Decidir el arreglo' : label}</span>;
}

export const BugTag = ({ p }: { p: { bug: unknown } }) => (p.bug ? <span className="pd-tag">Reporte de error</span> : null);
