import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_MANIFEST_FILE, parseAppManifest } from '../../app/manifest.js';
import { applyLinearSoon, queueLinearAssignment } from '../../core/linear-assign.js';
import type { LinearPlanning } from '../../core/linear-api.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import type { Session } from './auth.js';
import { commentOnIssue, createIssue } from './github-as-user.js';

// The dashboard's "Nuevo issue" (#100): an issue created on GitHub as
// whoever is logged in (#93), never through Linear — with the two-way sync
// it shows up there too, and the button keeps working if Linear goes. Then,
// if asked: assigned to ronin, which takes it like any issue assigned to it
// (discoverAssignedIssues), or a /spike or /spec commented on it as the
// person, which reaches ronin through its webhook like one written on GitHub.
// With Linear (#101), a project and a cycle can be chosen: applied once the
// sync creates the issue there (core/linear-assign.ts).

export type AfterCreate = 'none' | 'assign' | 'spike' | 'spec';

export interface NewIssue {
  title: string;
  body: string;
  after: AfterCreate;
  app?: string;
  instruction?: string;
  // Linear's ids, from the repo's planning.
  projectId?: string;
  cycleId?: string;
}

export class NewIssueError extends Error {}

const TITLE_MAX = 256;
const BODY_MAX = 60_000;

// The apps of the repo's ronin.app.json, for /spike and /spec; none if it has
// no manifest.
export async function repoApps(entry: RepoEntry): Promise<string[]> {
  try {
    return Object.keys(parseAppManifest(await readFile(join(entry.productRepoPath, APP_MANIFEST_FILE), 'utf8')).apps);
  } catch {
    return [];
  }
}

export function parseNewIssue(raw: Record<string, unknown>, apps: string[], planning?: LinearPlanning): NewIssue {
  const linear: Pick<NewIssue, 'projectId' | 'cycleId'> = {};
  if (typeof raw.projectId === 'string' && raw.projectId) {
    if (!planning?.projects.some((p) => p.id === raw.projectId)) throw new NewIssueError('Ese proyecto de Linear ya no está activo.');
    linear.projectId = raw.projectId;
  }
  if (typeof raw.cycleId === 'string' && raw.cycleId) {
    if (!planning?.cycles.some((c) => c.id === raw.cycleId)) throw new NewIssueError('Ese ciclo de Linear ya terminó.');
    linear.cycleId = raw.cycleId;
  }
  return { ...parseNew(raw, apps), ...linear };
}

function parseNew(raw: Record<string, unknown>, apps: string[]): NewIssue {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  const after = (raw.after ?? 'none') as AfterCreate;
  if (!title) throw new NewIssueError('Falta el título.');
  if (title.length > TITLE_MAX) throw new NewIssueError(`El título pasa de ${TITLE_MAX} caracteres.`);
  if (body.length > BODY_MAX) throw new NewIssueError('La descripción es demasiado larga.');
  if (!['none', 'assign', 'spike', 'spec'].includes(after)) throw new NewIssueError('No sé qué hacer después de crearlo.');
  if (after !== 'spike' && after !== 'spec') return { title, body, after };
  const app = typeof raw.app === 'string' ? raw.app : '';
  if (!apps.includes(app)) throw new NewIssueError(apps.length ? `/${after} necesita una de las apps del repo: ${apps.join(', ')}.` : `El repo no tiene ${APP_MANIFEST_FILE}: no hay apps para /${after}.`);
  const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim().replace(/\s+/g, ' ') : '';
  return { title, body, after, app, ...(instruction ? { instruction } : {}) };
}

// The comment that asks ronin for a /spike or /spec, as commands.ts reads it.
export function commandComment(roninLogin: string, issue: NewIssue): string {
  return `@${roninLogin} /${issue.after} ${issue.app}${issue.instruction ? ` ${issue.instruction}` : ''}`;
}

export async function createFromDashboard(entry: RepoEntry, session: Session, issue: NewIssue, roninLogin: string): Promise<{ id: string; number: number; url: string }> {
  const created = await createIssue(session.token, entry.productRepo, {
    title: issue.title,
    body: issue.body,
    ...(issue.after === 'assign' ? { assignees: [roninLogin] } : {}),
  });
  if (issue.after === 'spike' || issue.after === 'spec') await commentOnIssue(session.token, entry.productRepo, created.number, commandComment(roninLogin, issue));
  if (issue.projectId || issue.cycleId) {
    await withActiveRepo(entry, () => queueLinearAssignment({ number: created.number, ...(issue.projectId ? { projectId: issue.projectId } : {}), ...(issue.cycleId ? { cycleId: issue.cycleId } : {}) }));
    applyLinearSoon(entry);
  }
  return { id: `${entry.productRepo}#${created.number}`, ...created };
}
