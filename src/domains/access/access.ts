import { createHash } from 'node:crypto';
import { log } from '../../platform/logger.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';
import { GithubUserError } from '../../platform/github/github-as-user.js';
import type { Perms } from './team.js';
import { githubFetch } from '../../platform/github/rest.js';

// Which repos of repos.json a dashboard session sees (#106). Administrators
// (DASHBOARD_ADMINS) see them all. Anyone else sees the ones GitHub says
// they can at least triage, asked with their own session token: access to
// the dashboard follows access on GitHub, and there's no other list to keep.
// Read-only isn't enough — the dashboard shows transcripts, costs and
// previews.
//
// Asked at login and then cached per session for a few minutes, so someone
// taken off a repo on GitHub stops seeing it here soon after. If GitHub
// fails, the last answer stands; with none, nothing is seen (fails closed).

export type Permission = 'admin' | 'maintain' | 'push' | 'triage' | 'pull';

export interface Access {
  admin: boolean;
  // The productRepo of each repo the session sees, and the permission that lets it.
  // `perms`: what it can do there (#174, access/team.ts), once worked out.
  repos: Array<{ repo: string; permission: Permission | 'admin-del-tablero'; perms?: Perms }>;
}

const RANK: Permission[] = ['pull', 'triage', 'push', 'maintain', 'admin'];
export const MIN_PERMISSION: Permission = 'triage';
const TTL_MS = 10 * 60_000;

// The highest of GitHub's `permissions` on the repo, or null without access.
export function highest(permissions: Partial<Record<Permission, boolean>> | undefined): Permission | null {
  return [...RANK].reverse().find((p) => permissions?.[p]) ?? null;
}

export const enough = (permission: Permission | null) => permission !== null && RANK.indexOf(permission) >= RANK.indexOf(MIN_PERMISSION);

// The person's permission on one repo, with their token. 404: no access. A
// 401 (token revoked or expired) is the session's end, as with the actions.
export async function repoPermission(token: string, repo: string): Promise<Permission | null> {
  const response = await githubFetch(`/repos/${repo}`, { token });
  if (response.status === 401) throw new GithubUserError('Tu sesión de GitHub venció o se revocó. Volvé a entrar.', true);
  // An org that restricts OAuth apps answers 403 or 404 too: no access until it approves the dashboard.
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} al leer ${repo}`);
  return highest(((await response.json()) as { permissions?: Partial<Record<Permission, boolean>> }).permissions);
}

type Lookup = (token: string, repo: string) => Promise<Permission | null>;

// The repos the token can at least triage, out of `entries`.
async function lookUp(entries: RepoEntry[], token: string, lookup: Lookup): Promise<Access['repos']> {
  const found = await Promise.all(entries.map(async (entry) => [entry.productRepo, await lookup(token, entry.productRepo)] as const));
  return found.flatMap(([repo, permission]) => (permission && enough(permission) ? [{ repo, permission }] : []));
}

// By session (login and token): logging in again asks again.
const cache = new Map<string, { repos?: Access['repos']; readAt: number; reading?: Promise<Access['repos']> }>();
const keyOf = (login: string, token: string) => `${login}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

export async function sessionAccess(session: { login: string; token: string }, entries: RepoEntry[], admins: string[], now = Date.now(), lookup: Lookup = repoPermission): Promise<Access> {
  if (admins.includes(session.login)) return { admin: true, repos: entries.map((entry) => ({ repo: entry.productRepo, permission: 'admin-del-tablero' as const })) };
  const key = keyOf(session.login, session.token);
  const entry = cache.get(key) ?? { readAt: 0 };
  cache.set(key, entry);
  const fresh = entry.repos && now - entry.readAt < TTL_MS;
  if (!fresh && !entry.reading) {
    entry.reading = lookUp(entries, session.token, lookup)
      .then((repos) => {
        entry.repos = repos;
        entry.readAt = Date.now();
        return repos;
      })
      .catch((error) => {
        // The session's end goes up to the caller; anything else keeps the last answer.
        if (error instanceof GithubUserError) {
          cache.delete(key);
          throw error;
        }
        log.error(`tablero: no se pudieron leer los permisos de ${session.login} en GitHub`, error);
        entry.readAt = Date.now();
        entry.repos ??= [];
        return entry.repos;
      })
      .finally(() => {
        entry.reading = undefined;
      });
  }
  // The first answer is waited for; after that, the previous one is served
  // while a new one comes (a revoked token then shows on the next request).
  if (entry.repos) entry.reading?.catch(() => undefined);
  const repos = entry.repos ?? (await entry.reading!);
  const known = new Set(entries.map((e) => e.productRepo));
  return { admin: false, repos: repos.filter((r) => known.has(r.repo)) };
}

export function resetAccessCache(): void {
  cache.clear();
}

// Whether the session sees this repo.
export const sees = (access: Access, repo: string) => access.repos.some((r) => r.repo === repo);
