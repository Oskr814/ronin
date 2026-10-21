import type { Context } from 'hono';
import { loadRepos } from '../../platform/config/repos.js';
import { sees, type Access } from './access.js';
import { listRuns } from '../runs/data.js';
import { can, type Perm } from './team.js';

// What a dashboard session sees (#106): only the repos access/access.ts lets it,
// and their runs. Every read of the dashboard's routes goes through here.

export async function visibleRepos(access: Access) {
  return (await loadRepos()).filter((entry) => sees(access, entry.productRepo));
}

export async function visibleRuns(access: Access, days: number) {
  return (await listRuns(days)).filter((run) => sees(access, run.repo));
}

// What a member can do in each repo (#174, access/team.ts), checked for every
// change: the page hides what they can't, but the server is what says no.
export const PERM_REFUSAL: Record<Perm, string> = {
  notas: 'no tienes permiso para subir notas de reuniones en este repo',
  aprobar: 'no tienes permiso para aprobar lo que propone una reunión en este repo',
  acciones: 'no tienes permiso para las acciones del tablero en este repo (asignar a ronin, comandos, revisar, auto-merge)',
  desplegar: 'no tienes permiso para desplegar este repo',
};

// The 403 when the session can't do `perm` in `repo`, or null.
export function refusal(c: Context, access: Access, repo: string, perm: Perm): Response | null {
  return can(access, repo, perm) ? null : c.json({ error: PERM_REFUSAL[perm] }, 403);
}
