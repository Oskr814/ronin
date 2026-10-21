import { join } from 'node:path';
import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';
import { readJson, withJson } from '../portal/json-store.js';
import { sessionAccess, type Access } from './access.js';
import type { NotifyEvent } from '../../platform/notify/notifications.js';

// The team that enters the dashboard with GitHub (#174, stage 2): who they
// are (their profile), their role and what they can do in each repo. Kept in
// <SETTINGS_DATA_DIR>/people.json. GitHub still says which repos each one
// sees (access/access.ts); here an admin can only take some away and limit what
// they do in them, never give more.
//
// Nothing configured, everything works as before: DASHBOARD_ADMINS are the
// admins, DASHBOARD_ALLOWED_USERS who gets in, and a member does everything
// but deploy in the repos GitHub gives them.

export const PERMS = ['notas', 'aprobar', 'acciones', 'desplegar'] as const;
export type Perm = (typeof PERMS)[number];
export type Perms = Record<Perm, boolean>;

// What a member does in a repo: one of these sets, or their own choice of
// the three. Deploying goes apart, given repo by repo: it was admins only
// before (#158), and no set turns it on for everyone.
type SetPerms = Omit<Perms, 'desplegar'>;
export const SETS = {
  todo: { notas: true, aprobar: true, acciones: true },
  reuniones: { notas: true, aprobar: true, acciones: false },
  lectura: { notas: false, aprobar: false, acciones: false },
} satisfies Record<string, SetPerms>;
export type SetName = keyof typeof SETS;
export const isSetName = (value: unknown): value is SetName => typeof value === 'string' && value in SETS;

export interface RepoGrant {
  set?: SetName;
  // Their own choice instead of a set (Personalizado).
  custom?: SetPerms;
  desplegar?: boolean;
  // Taken out of the dashboard for them, though GitHub gives it.
  hidden?: boolean;
}

export interface Member {
  name?: string;
  email?: string;
  // Who they are in each repo's Linear team, by productRepo.
  linear?: Record<string, { id: string; name: string }>;
  role?: 'admin' | 'member';
  repos?: Record<string, RepoGrant>;
  addedBy?: string;
  addedAt?: string;
  lastSeenAt?: string;
  // The emails they chose per repo (#174, stage 4; platform/notify/notifications.ts reads them).
  notify?: Record<string, NotifyEvent[]>;
}

export interface TeamFile {
  people: Record<string, Member>;
  // Who gets in: anyone GitHub lets triage a repo, or only the people listed
  // here (and the admins). Unset, DASHBOARD_ALLOWED_USERS decides, as before.
  entrada?: 'github' | 'lista';
  // The set of a member in a repo they have none chosen for. Unset: todo.
  porDefecto?: SetName;
}

export const teamPath = () => join(config.settings.dataDir, 'people.json');
const empty = (): TeamFile => ({ people: {} });

export async function readTeam(): Promise<TeamFile> {
  const team = await readJson(teamPath(), empty);
  team.people ??= {};
  return team;
}

export function withTeam<R>(fn: (team: TeamFile) => R | Promise<R>): Promise<R> {
  return withJson(teamPath(), empty, (team) => {
    team.people ??= {};
    return fn(team);
  });
}

const envLogins = (value: string | undefined) => (value ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
// Read again from the environment: config.dashboard's lists are rewritten
// below, so they can't be where the .env values come from.
export const envAdmins = () => envLogins(process.env.DASHBOARD_ADMINS);
const envAllowed = () => envLogins(process.env.DASHBOARD_ALLOWED_USERS);

export const isAdmin = (team: TeamFile, login: string) => envAdmins().includes(login) || team.people[login]?.role === 'admin';

export function entradaOf(team: TeamFile): 'github' | 'lista' {
  return team.entrada ?? (envAllowed().length ? 'lista' : 'github');
}

// The lists apps/api/http/auth.ts reads at login and on every request (config.dashboard,
// the same object it was given), rewritten from .env and people.json. Called
// when the server starts and after every change to the team. With entrada
// "lista", DASHBOARD_ALLOWED_USERS stays in: nobody it let in is shut out
// by switching.
export function applyTeam(team: TeamFile, target: { admins: string[]; allowedUsers: string[] } = config.dashboard as unknown as { admins: string[]; allowedUsers: string[] }): void {
  const admins = [...new Set([...envAdmins(), ...Object.entries(team.people).filter(([, m]) => m.role === 'admin').map(([login]) => login)])];
  const allowed = entradaOf(team) === 'github' ? [] : [...new Set([...envAllowed(), ...Object.keys(team.people)])];
  target.admins.splice(0, target.admins.length, ...admins);
  target.allowedUsers.splice(0, target.allowedUsers.length, ...allowed);
}

export async function loadTeam(): Promise<void> {
  try {
    applyTeam(await readTeam());
  } catch (error) {
    log.error(`equipo: no se pudo leer ${teamPath()}, quedan los de .env`, error);
  }
}

export function permsFor(team: TeamFile, login: string, repo: string): Perms {
  if (isAdmin(team, login)) return { notas: true, aprobar: true, acciones: true, desplegar: true };
  const grant = team.people[login]?.repos?.[repo];
  const base = grant?.custom ?? SETS[grant?.set ?? team.porDefecto ?? 'todo'];
  return { ...base, desplegar: grant?.desplegar === true };
}

// Which repos a session sees and what it can do in each: GitHub's answer
// (access/access.ts), less what an admin hid, with each repo's permissions.
export async function teamAccess(session: { login: string; token: string }, entries: RepoEntry[]): Promise<Access> {
  const team = await readTeam().catch((error) => {
    log.error(`equipo: no se pudo leer ${teamPath()}, uso solo lo de .env`, error);
    return empty();
  });
  const admins = [...new Set([...envAdmins(), ...Object.entries(team.people).filter(([, m]) => m.role === 'admin').map(([login]) => login)])];
  const base = await sessionAccess(session, entries, admins);
  if (base.admin) return { ...base, repos: base.repos.map((r) => ({ ...r, perms: permsFor(team, session.login, r.repo) })) };
  const grants = team.people[session.login]?.repos ?? {};
  return {
    admin: false,
    repos: base.repos.filter((r) => !grants[r.repo]?.hidden).map((r) => ({ ...r, perms: permsFor(team, session.login, r.repo) })),
  };
}

// Whether the session can do that in the repo. Without permissions worked
// out (a test, an older Access), what was allowed before: everything but
// deploying, which was the admins'.
export function can(access: Access, repo: string, perm: Perm): boolean {
  if (access.admin) return true;
  const entry = access.repos.find((r) => r.repo === repo);
  if (!entry) return false;
  return entry.perms ? entry.perms[perm] : perm !== 'desplegar';
}

// When each one last used the dashboard, written at most every few minutes.
const SEEN_EVERY_MS = 10 * 60_000;
const seen = new Map<string, number>();
export async function touchSeen(login: string, now = Date.now()): Promise<void> {
  if (now - (seen.get(login) ?? 0) < SEEN_EVERY_MS) return;
  seen.set(login, now);
  await withTeam((team) => {
    team.people[login] = { ...(team.people[login] ?? {}), lastSeenAt: new Date(now).toISOString() };
  }).catch((error) => log.error(`equipo: no se pudo anotar la entrada de ${login}`, error));
}
