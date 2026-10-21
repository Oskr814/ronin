import type { MeetingDetail, MeetingRow } from '../../api.js';

// What the meetings' pages know of a meeting, and how they write it (#62).

export type Detail = MeetingDetail;
export type Proposals = NonNullable<Detail['proposals']>;
export type Issue = Proposals['issues'][number];

export const STATUS: Record<string, [string, string]> = {
  pending: ['run', 'En cola para ronin'], reading: ['run', 'ronin la está leyendo'], review: ['warn', 'Espera revisión'],
  empty: ['idle', 'Nada accionable'], failed: ['crit', 'Falló la lectura'], done: ['ok', 'Creado'], discarded: ['idle', 'Descartada'],
};
const KIND: Record<string, string> = { pdf: 'PDF', docx: 'Word', text: 'Texto', pasted: 'Pegado' };
export const CYCLE: Record<string, string> = { current: 'el ciclo actual', next: 'el próximo ciclo' };
export const MAX_BYTES = 10 * 1024 * 1024;

export const source = (m: Pick<MeetingRow, 'source'>) => `${KIND[m.source.kind] ?? m.source.kind}${m.source.pages ? ` · ${m.source.pages} ${m.source.pages === 1 ? 'página' : 'páginas'}` : ''}`;
export const chars = (n: number) => `${n.toLocaleString('es')} caracteres`;
// The notes' lines with text, numbered from 1: what ronin cites (meetings.ts's noteLines).
export const noteLines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The review (#62, entrega 3): what the person marks and changes, by
// proposal id, kept while the page is open.
export interface Form {
  on: Record<string, boolean>;
  title: Record<string, string>;
  body: Record<string, string>;
  lead: Record<string, string>;
  project: Record<string, string>;
  cycle: Record<string, string>;
}
export type Field = Exclude<keyof Form, 'on'>;

export function newForm(d: Detail): Form {
  const p = d.proposals!;
  const f: Form = { on: {}, title: {}, body: {}, lead: {}, project: {}, cycle: {} };
  for (const x of [...p.projects.flatMap((x) => [x, ...x.issues]), ...p.issues, ...p.comments]) f.on[x.id] = !d.results[x.id]?.ok;
  return f;
}

export const editable = (d: Detail) => d.status === 'review';
export const created = (d: Detail, id: string) => Boolean(d.results[id]?.ok);

// What will be created: the marked ones not created yet.
export function chosen(d: Detail, f: Form) {
  const p = d.proposals!;
  const pick = (x: { id: string }) => f.on[x.id] && !created(d, x.id);
  return {
    projects: p.projects.filter(pick).length,
    issues: [...p.projects.flatMap((x) => x.issues), ...p.issues].filter(pick).length,
    comments: p.comments.filter(pick).length,
  };
}

// What approving sends: each one marked and not created, with what was changed of it.
export function approveItems(d: Detail, f: Form) {
  const p = d.proposals!;
  const ids = [...p.projects.flatMap((x) => [x.id, ...x.issues.map((i) => i.id)]), ...p.issues.map((i) => i.id), ...p.comments.map((c) => c.id)].filter((id) => f.on[id] && !created(d, id));
  const fields: Field[] = ['title', 'body', 'lead', 'project', 'cycle'];
  return ids.map((id) => ({ id, ...fields.reduce((o, k) => (f[k][id] !== undefined ? { ...o, [k]: f[k][id] } : o), {}) }));
}

// What each line of the notes is cited by.
export function citedBy(d: Detail): Record<number, Set<string>> {
  const by: Record<number, Set<string>> = {};
  const add = (cites: number[], label: string) => {
    for (const c of cites) (by[c] ??= new Set()).add(label);
  };
  const p = d.proposals;
  if (!p) return by;
  for (const x of p.projects) {
    add(x.cites, 'proyecto');
    for (const i of x.issues) add(i.cites, 'proyecto');
  }
  for (const i of p.issues) add(i.cites, 'issue');
  for (const c of p.comments) add(c.cites, `#${c.issue}`);
  for (const x of p.discarded) add(x.cites, 'descartado');
  return by;
}
