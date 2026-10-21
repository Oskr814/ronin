import { config } from '../../core/config.js';
import { applyLinearSoon, queueLinearAssignment } from '../../core/linear-assign.js';
import { createProject, linearKey, teamContext, type LinearContext } from '../../core/linear-api.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { tryLockResource, unlockResource } from '../../core/locks.js';
import { addEvent, getMeeting, updateMeeting, type Meeting, type ProposalOutcome, type ProposalResult, type ProposedCycle, type ProposedIssue } from './index.js';
import type { Session } from '../../apps/api/http/auth.js';
import { commentOnIssue, createIssue, GithubUserError } from '../../core/github-as-user.js';

// Someone approves what they chose of a meeting's proposals (#62), with
// their edits: the issues and comments go to GitHub as them, with their
// session (like a new issue, §15.11.1); a new project goes to Linear with
// the repo's key, and its issues and their cycles get there through
// linear-assign once the sync brings them. Each proposal's outcome is kept
// as soon as it's known, so trying again never creates one twice.

export class ApproveError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const TITLE_MAX = 256;
const BODY_MAX = 60_000;

// What the person chose, by proposal id, with what they changed.
export interface Choice {
  id: string;
  title?: string;
  body?: string;
  lead?: string;
  project?: string;
  cycle?: ProposedCycle | '';
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);

export function parseChoices(raw: unknown, meeting: Meeting): Choice[] {
  const p = meeting.proposals;
  if (!p) throw new ApproveError('Esa reunión no tiene propuestas.', 409);
  if (!Array.isArray(raw) || !raw.length) throw new ApproveError('Marca al menos una propuesta.');
  const ids = new Set([...p.projects.flatMap((x) => [x.id, ...x.issues.map((i) => i.id)]), ...p.issues.map((i) => i.id), ...p.comments.map((c) => c.id)]);
  const choices = raw.map((item): Choice => {
    const r = (item ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? '');
    if (!ids.has(id)) throw new ApproveError('Una de las propuestas ya no existe.');
    const title = str(r.title);
    const body = str(r.body);
    if (title !== undefined && (!title || title.length > TITLE_MAX)) throw new ApproveError(title ? `Un título pasa de ${TITLE_MAX} caracteres.` : 'Un título quedó vacío.');
    if (body !== undefined && (!body || body.length > BODY_MAX)) throw new ApproveError(body ? 'Una descripción es demasiado larga.' : 'Una descripción quedó vacía.');
    const cycle = r.cycle === undefined ? undefined : r.cycle === '' || r.cycle === 'current' || r.cycle === 'next' ? (r.cycle as Choice['cycle']) : null;
    if (cycle === null) throw new ApproveError('Un ciclo no se entiende.');
    return { id, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(str(r.lead) !== undefined ? { lead: str(r.lead) } : {}), ...(str(r.project) !== undefined ? { project: str(r.project) } : {}), ...(cycle !== undefined ? { cycle } : {}) };
  });
  // An issue of a new project needs the project.
  for (const project of p.projects) {
    if (project.issues.some((i) => choices.some((c) => c.id === i.id)) && !choices.some((c) => c.id === project.id) && !meeting.results?.[project.id]?.ok) {
      throw new ApproveError(`Los issues de "${project.name}" van dentro del proyecto: márcalo también.`);
    }
  }
  return choices;
}

function cycleId(ctx: LinearContext | null, cycle: ProposedCycle | '' | undefined): string | undefined {
  if (!ctx || !cycle) return undefined;
  const current = ctx.cycles.find((c) => c.current);
  if (cycle === 'current') return current?.id;
  return ctx.cycles.find((c) => !c.current && (!current || c.startsAt >= current.endsAt))?.id;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: config.exploreTimezone }) : null);

// Where it came from, at the end of what's created: never the notes themselves.
export function origin(meeting: Meeting, login: string): string {
  const day = when(meeting.at);
  return `---\n_De la reunión R-${meeting.number}, "${meeting.title}"${day ? ` (${day})` : ''}: lo propuso ronin y lo aprobó ${login} en el tablero._`;
}

const errorText = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0].slice(0, 300);

export interface ApproveOutcome {
  created: number;
  failed: number;
  status: Meeting['status'];
}

export async function approveMeeting(entry: RepoEntry, n: number, session: Session, raw: unknown): Promise<ApproveOutcome> {
  return withActiveRepo(entry, async () => {
    const resource = `meeting-approve-${n}`;
    if (!(await tryLockResource(resource))) throw new ApproveError('Alguien ya está creando lo de esta reunión.', 409);
    try {
      return await approve(entry, n, session, raw);
    } finally {
      await unlockResource(resource);
    }
  });
}

async function approve(entry: RepoEntry, n: number, session: Session, raw: unknown): Promise<ApproveOutcome> {
  const meeting = await getMeeting(n);
  if (!meeting || meeting.status !== 'review') throw new ApproveError('Esa reunión no espera revisión.', 409);
  const choices = parseChoices(raw, meeting);
  const chosen = new Map(choices.map((c) => [c.id, c]));
  const p = meeting.proposals!;
  const key = linearKey(entry);
  const ctx = key ? await teamContext(entry, key) : null;
  if (key && !ctx) throw new ApproveError('No se pudo leer el equipo de Linear del repo.', 502);
  const results: Record<string, ProposalResult> = { ...meeting.results };
  let created = 0;
  let failed = 0;
  let queued = false;
  const footer = origin(meeting, session.login);

  const keep = async (id: string, result: ProposalOutcome) => {
    const full = { ...result, by: session.login, at: new Date().toISOString() } as ProposalResult;
    results[id] = full;
    if (full.ok) created += 1;
    else failed += 1;
    await updateMeeting(n, (m) => {
      (m.results ??= {})[id] = full;
    });
  };

  // One proposal: done before, nothing; else `fn`, and its outcome kept. A
  // session GitHub no longer takes stops everything (the page asks to log in again).
  const each = async (id: string, fn: () => Promise<ProposalOutcome>) => {
    if (!chosen.has(id) || results[id]?.ok) return;
    try {
      await keep(id, await fn());
    } catch (error) {
      if (error instanceof GithubUserError && error.relogin) throw error;
      log.error(`reuniones: R-${n}: no se pudo crear ${id}`, error);
      await keep(id, { ok: false, error: errorText(error) });
    }
  };

  const issue = async (proposal: ProposedIssue, projectId: string | undefined) => {
    const choice = chosen.get(proposal.id)!;
    const made = await createIssue(session.token, entry.productRepo, { title: choice.title ?? proposal.title, body: `${choice.body ?? proposal.body}\n\n${footer}` });
    const cycle = cycleId(ctx, choice.cycle ?? proposal.cycle);
    if (projectId || cycle) {
      await queueLinearAssignment({ number: made.number, ...(projectId ? { projectId } : {}), ...(cycle ? { cycleId: cycle } : {}) });
      queued = true;
    }
    return { ok: true as const, url: made.url, number: made.number };
  };

  for (const project of p.projects) {
    await each(project.id, async () => {
      if (!key || !ctx) throw new Error('El repo no usa Linear: no se pueden crear proyectos.');
      const choice = chosen.get(project.id)!;
      const leadName = choice.lead ?? project.lead;
      const lead = leadName ? ctx.people.find((x) => x.name === leadName) : undefined;
      const description = choice.body ?? project.description;
      const made = await createProject(key, { name: choice.title ?? project.name, description, content: `${description}\n\n${footer}`, teamId: ctx.teamId, ...(lead ? { leadId: lead.id } : {}) });
      return { ok: true, url: made.url, projectId: made.id };
    });
    const made = results[project.id];
    for (const kid of project.issues) {
      await each(kid.id, async () => {
        if (!made?.ok || !made.projectId) throw new Error('Su proyecto no se creó.');
        return issue(kid, made.projectId);
      });
    }
  }
  for (const loose of p.issues) {
    await each(loose.id, async () => {
      const name = chosen.get(loose.id)!.project ?? loose.project;
      const projectId = name ? ctx?.projects.find((x) => x.name === name)?.id : undefined;
      if (name && !projectId) throw new Error(`No existe el proyecto "${name}" en Linear.`);
      return issue(loose, projectId);
    });
  }
  for (const comment of p.comments) {
    await each(comment.id, async () => {
      const choice = chosen.get(comment.id)!;
      const posted = await commentOnIssue(session.token, entry.productRepo, comment.issue, `${choice.body ?? comment.body}\n\n${footer}`);
      const cycle = cycleId(ctx, choice.cycle ?? comment.cycle);
      if (cycle) {
        await queueLinearAssignment({ number: comment.issue, cycleId: cycle });
        queued = true;
      }
      return { ok: true, url: posted.url, number: comment.issue };
    });
  }
  if (queued) applyLinearSoon(entry);

  const done = choices.every((c) => results[c.id]?.ok);
  const updated = await updateMeeting(n, (m) => {
    if (done) m.status = 'done';
    addEvent(m, { kind: 'approved', by: session.login, created, failed });
    return m;
  });
  log.info(`reuniones: R-${n}: ${session.login} aprobó; ${created} creados, ${failed} fallaron`);
  return { created, failed, status: updated.status };
}

// Someone sets the whole meeting aside: nothing is created.
export async function discardMeeting(n: number, login: string): Promise<void> {
  const ok = await updateMeeting(n, (m) => {
    if (m.status !== 'review' && m.status !== 'empty' && m.status !== 'failed') return false;
    // What was already created stays created: only what's left is set aside.
    m.status = 'discarded';
    addEvent(m, { kind: 'discarded', by: login });
    return true;
  });
  if (!ok) throw new ApproveError('Esa reunión ya no se puede descartar.', 409);
}
