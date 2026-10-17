import type { Discarded, Proposals, ProposedComment, ProposedCycle, ProposedIssue, ProposedProject } from './meetings.js';

// What ronin's agent proposes out of a meeting's notes (#62), checked
// against what's really there before anyone sees it: every proposal cites
// lines the notes have, a comment goes on an issue that's open, an issue's
// project and a project's lead are the Linear team's. What doesn't hold is
// dropped (and said in the log), never fixed by guessing.

export const LIMITS = { projects: 5, projectIssues: 10, issues: 15, comments: 10, discarded: 20 };
const MAX = { title: 200, body: 6000, why: 600, summary: 1200, topic: 200 };

export interface ProposalContext {
  // How many lines the notes have (noteLines).
  lines: number;
  // The repo's open issues, by number, with their titles.
  openIssues: Map<number, string>;
  // Without Linear there are no projects, cycles nor leads.
  linear: { projects: string[]; people: string[] } | null;
}

export type Parsed = Omit<Proposals, 'at'> & { dropped: string[] };

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)) : []);

// Case and accents don't count when matching a name the agent wrote.
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const byName = (names: string[], wanted: unknown) => (typeof wanted === 'string' && wanted.trim() ? names.find((n) => fold(n) === fold(wanted)) : undefined);

function cycleOf(value: unknown): ProposedCycle | undefined {
  const v = typeof value === 'string' ? fold(value) : '';
  return v === 'actual' ? 'current' : v === 'proximo' ? 'next' : undefined;
}

export function parseProposals(raw: string, ctx: ProposalContext): Parsed {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('el resultado no es un objeto JSON');
  const r = parsed as Record<string, unknown>;
  const dropped: string[] = [];
  const cites = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).filter((c): c is number => Number.isInteger(c) && c >= 1 && c <= ctx.lines))].sort((a, b) => a - b);

  // An issue, in a project or on its own: null when it can't stand.
  const issue = (x: Record<string, unknown>, id: string, inProject: boolean): ProposedIssue | null => {
    const title = text(x.titulo, MAX.title);
    const body = text(x.descripcion, MAX.body);
    const c = cites(x.citas);
    if (!title || !body || !c.length) {
      dropped.push(`issue "${title || '(sin título)'}": ${!title || !body ? 'sin título o sin descripción' : 'sin citas de las notas'}`);
      return null;
    }
    const project = !inProject && ctx.linear ? byName(ctx.linear.projects, x.proyecto) : undefined;
    if (!inProject && x.proyecto && !project) dropped.push(`proyecto "${String(x.proyecto)}" del issue "${title}": no existe en Linear`);
    const cycle = ctx.linear ? cycleOf(x.ciclo) : undefined;
    return { id, title, body, why: text(x.por_que, MAX.why), cites: c, ...(project ? { project } : {}), ...(cycle ? { cycle } : {}) };
  };

  const projects: ProposedProject[] = [];
  const loose: ProposedIssue[] = [];
  for (const [i, x] of list(r.proyectos).entries()) {
    const kids = list(x.issues).slice(0, LIMITS.projectIssues).map((k, j) => issue(k, `p${i + 1}-${j + 1}`, true)).filter((k): k is ProposedIssue => Boolean(k));
    // Without Linear, a project can't be made: its issues stand on their own.
    if (!ctx.linear) {
      loose.push(...kids);
      continue;
    }
    const name = text(x.nombre, MAX.title);
    const c = cites(x.citas);
    if (!name || !c.length || !kids.length) {
      dropped.push(`proyecto "${name || '(sin nombre)'}": ${!name ? 'sin nombre' : !c.length ? 'sin citas de las notas' : 'sin issues'}`);
      continue;
    }
    if (byName(ctx.linear.projects, name)) {
      dropped.push(`proyecto "${name}": ya existe en Linear`);
      continue;
    }
    const lead = byName(ctx.linear.people, x.lider);
    projects.push({ id: `p${i + 1}`, name, description: text(x.descripcion, MAX.body), why: text(x.por_que, MAX.why), cites: c, ...(lead ? { lead } : {}), issues: kids });
  }

  const issues = [...loose, ...list(r.issues).map((x, i) => issue(x, `i${i + 1}`, false)).filter((x): x is ProposedIssue => Boolean(x))].slice(0, LIMITS.issues);

  const comments: ProposedComment[] = [];
  for (const [i, x] of list(r.comentarios).entries()) {
    const number = Number(x.issue);
    const body = text(x.comentario, MAX.body);
    const c = cites(x.citas);
    const title = ctx.openIssues.get(number);
    if (!title || !body || !c.length) {
      dropped.push(`comentario en #${String(x.issue)}: ${!title ? 'no es un issue abierto del repo' : !body ? 'vacío' : 'sin citas de las notas'}`);
      continue;
    }
    const cycle = ctx.linear ? cycleOf(x.ciclo) : undefined;
    comments.push({ id: `c${i + 1}`, issue: number, issueTitle: title, body, why: text(x.por_que, MAX.why), cites: c, ...(cycle ? { cycle } : {}) });
  }

  const discarded: Discarded[] = list(r.descartado)
    .map((x) => ({ topic: text(x.tema, MAX.topic), why: text(x.motivo, MAX.why), cites: cites(x.citas) }))
    .filter((d) => d.topic && d.why);

  return {
    summary: text(r.resumen, MAX.summary),
    projects: projects.slice(0, LIMITS.projects),
    issues,
    comments: comments.slice(0, LIMITS.comments),
    discarded: discarded.slice(0, LIMITS.discarded),
    dropped,
  };
}

export const proposalCount = (p: Pick<Proposals, 'projects' | 'issues' | 'comments'>) => p.projects.length + p.issues.length + p.comments.length;
