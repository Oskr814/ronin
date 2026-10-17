import { config } from '../../core/config.js';
import { currentCycle, linearIssuesFor, linearKey, type LinearCycle, type LinearIssue } from '../../core/linear-api.js';
import { log } from '../../core/logger.js';
import type { RepoEntry } from '../../core/repo-context.js';
import type { RepoGithub } from './dashboard-github.js';

// What the dashboard reads from Linear (#101), per repo with an API key: the
// Linear issue of each open issue (its project and cycle, for the sidebar and
// the ficha) and the team's current cycle (for Hoy). Cached like
// the GitHub read (dashboard-github.ts), and failing the same way: the
// previous read stays, with the error. A repo without a key reads nothing.

export interface RepoLinear {
  repo: string;
  // The workspace's URL key ("red-motos"), from its issues' URLs.
  workspace?: string;
  fetchedAt: string;
  issues: Record<number, LinearIssue>;
  cycle: LinearCycle | null;
  error?: string;
}

async function fetchLinear(entry: RepoEntry, key: string, gh: RepoGithub | undefined): Promise<RepoLinear> {
  // Every open issue: the sidebar finds any of them, and filters them by cycle or project (#100).
  const numbers = [...new Set([...(gh?.issues ?? []), ...(gh?.openIssues ?? [])].map((i) => i.number))];
  const [issues, cycle] = await Promise.all([linearIssuesFor(entry, key, numbers), currentCycle(entry, key)]);
  const anyUrl = [...issues.values()][0]?.url ?? cycle?.issues[0]?.url;
  const workspace = anyUrl ? /^https:\/\/linear\.app\/([^/]+)\//.exec(anyUrl)?.[1] : undefined;
  return {
    repo: entry.productRepo,
    ...(workspace ? { workspace } : {}),
    fetchedAt: new Date().toISOString(),
    issues: Object.fromEntries(issues),
    cycle,
  };
}

const cache = new Map<string, { data?: RepoLinear; readAt: number; reading?: Promise<RepoLinear> }>();

export async function repoLinear(entry: RepoEntry, gh: RepoGithub | undefined, now = Date.now()): Promise<RepoLinear | undefined> {
  const key = linearKey(entry);
  if (!key) return undefined;
  const entryCache = cache.get(entry.productRepo) ?? { readAt: 0 };
  cache.set(entry.productRepo, entryCache);
  if (entryCache.data && now - entryCache.readAt < config.dashboard.githubTtlSeconds * 1000) return entryCache.data;

  if (!entryCache.reading) {
    entryCache.reading = fetchLinear(entry, key, gh)
      .then((data) => {
        entryCache.data = data;
        entryCache.readAt = Date.now();
        return data;
      })
      .catch((error) => {
        log.error(`tablero: no se pudo leer Linear para ${entry.productRepo}`, error);
        entryCache.readAt = Date.now();
        const stale = entryCache.data ?? { repo: entry.productRepo, fetchedAt: '', issues: {}, cycle: null };
        entryCache.data = { ...stale, error: (error as Error).message.split('\n')[0] };
        return entryCache.data;
      })
      .finally(() => {
        entryCache.reading = undefined;
      });
  }
  return entryCache.data ?? entryCache.reading;
}

export function resetLinearCache(): void {
  cache.clear();
}

// Where a cycle issue stands, for Hoy's cycle card. ronin's issues by what
// ronin knows of them (GitHub); the team's by their Linear state.
export type CycleBucket = 'done' | 'ronin' | 'review' | 'blocked' | 'started' | 'todo';

export interface CycleIssueView {
  id: string;
  title: string;
  url: string;
  number?: number;
  project?: { id: string; name: string };
  // "ronin" for an issue ronin manages, else its assignee in Linear, else "".
  owner: string;
  bucket: CycleBucket;
}

export interface CycleView {
  repo: string;
  workspace?: string;
  team: string;
  number: number;
  name?: string;
  startsAt: string;
  endsAt: string;
  scopeHistory: number[];
  doneHistory: number[];
  issues: CycleIssueView[];
}

export function cycleView(linear: RepoLinear, gh: RepoGithub | undefined): CycleView | null {
  const cycle = linear.cycle;
  if (!cycle) return null;
  const openPrs = new Set((gh?.prs ?? []).map((pr) => pr.number));
  const issues = cycle.issues.map((issue): CycleIssueView => {
    const managed = issue.githubNumber !== undefined ? gh?.issues.find((i) => i.number === issue.githubNumber && i.status !== 'other') : undefined;
    let bucket: CycleBucket;
    if (issue.state.type === 'completed') bucket = 'done';
    else if (managed?.status === 'blocked') bucket = 'blocked';
    else if (managed) bucket = managed.slices.some((s) => !s.checked && s.prNumber !== null && openPrs.has(s.prNumber)) ? 'review' : 'ronin';
    else if (issue.state.type === 'started') bucket = /review/i.test(issue.state.name) ? 'review' : 'started';
    else bucket = 'todo';
    return {
      id: issue.id,
      title: issue.title,
      url: issue.url,
      ...(issue.githubNumber !== undefined ? { number: issue.githubNumber } : {}),
      ...(issue.project ? { project: issue.project } : {}),
      owner: managed ? 'ronin' : issue.assignee ?? '',
      bucket,
    };
  });
  return {
    repo: linear.repo,
    ...(linear.workspace ? { workspace: linear.workspace } : {}),
    team: cycle.team,
    number: cycle.number,
    ...(cycle.name ? { name: cycle.name } : {}),
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    scopeHistory: cycle.scopeHistory,
    doneHistory: cycle.doneHistory,
    issues,
  };
}
