import { config } from '../../core/config.js';
import { getDiscussion, type Discussion } from '../../core/github.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import type { RepoGithub } from './dashboard-github.js';

// An item's page in the dashboard (#85): the issue's and the PR's bodies and
// the item's own comments, so the center has something to show whether or
// not an agent ran on it. An issue brings the slice PR that's moving; a
// slice PR, its tracking issue.
//
// Read only when an item is opened, never for the sidebar, and cached like
// the repo reads (dashboard-github.ts): DASHBOARD_GITHUB_TTL_SECONDS, or
// sooner when one of the item's runs started or ended since.

export interface ItemRef {
  kind: 'issue' | 'pr';
  number: number;
  // The other half: an issue's moving PR, a slice PR's issue.
  issue?: number;
  pr?: number;
}

export interface ItemDetail {
  fetchedAt: string;
  issue?: Discussion;
  pr?: Discussion;
  error?: string;
}

const SLICE_BRANCH = /^ronin\/(\d+)\//;

// What `number` is in this repo, from the cached repo read. `runKind`: what
// its runs say it is, for one GitHub doesn't list (a human's PR, a closed
// issue).
export function resolveItem(number: number, gh: RepoGithub | undefined, runKind?: 'issue' | 'pr'): ItemRef | null {
  const issue = gh?.issues.find((i) => i.number === number);
  if (issue) {
    const open = new Set(gh!.prs.map((pr) => pr.number));
    const moving = issue.slices.find((s) => !s.checked && s.prNumber !== null && open.has(s.prNumber));
    return { kind: 'issue', number, ...(moving?.prNumber ? { pr: moving.prNumber } : {}) };
  }
  const pr = gh?.prs.find((p) => p.number === number);
  if (pr) {
    const tracking = gh!.issues.find((i) => i.slices.some((s) => s.prNumber === number))?.number ?? Number(SLICE_BRANCH.exec(pr.headRefName)?.[1] ?? NaN);
    return { kind: 'pr', number, ...(Number.isInteger(tracking) ? { issue: tracking } : {}) };
  }
  return runKind ? { kind: runKind, number } : null;
}

const MAX_COMMENTS = 50;

async function fetchDetail(entry: RepoEntry, ref: ItemRef): Promise<ItemDetail> {
  return withActiveRepo(entry, async () => {
    const issueNumber = ref.kind === 'issue' ? ref.number : ref.issue;
    const prNumber = ref.kind === 'pr' ? ref.number : ref.pr;
    const [issue, pr] = await Promise.all([
      issueNumber !== undefined ? getDiscussion('issue', issueNumber) : undefined,
      prNumber !== undefined ? getDiscussion('pr', prNumber) : undefined,
    ]);
    // Only the item's own comments are shown; the other half's are on GitHub.
    const trim = (d: Discussion | undefined, own: boolean) => d && { ...d, comments: own ? d.comments.slice(-MAX_COMMENTS) : [] };
    return {
      fetchedAt: new Date().toISOString(),
      ...(issue ? { issue: trim(issue, ref.kind === 'issue') } : {}),
      ...(pr ? { pr: trim(pr, ref.kind === 'pr') } : {}),
    };
  });
}

const cache = new Map<string, { data?: ItemDetail; readAt: number; reading?: Promise<ItemDetail> }>();
// Items nobody opened in a while are dropped, so the cache doesn't grow with every item ever opened.
const FORGET_MS = 30 * 60_000;

export async function itemDetail(entry: RepoEntry, ref: ItemRef, changedSince = 0, now = Date.now()): Promise<ItemDetail> {
  for (const [key, value] of cache) if (!value.reading && now - value.readAt > FORGET_MS) cache.delete(key);
  const key = `${entry.productRepo}#${ref.kind}${ref.number}:${ref.issue ?? ''}:${ref.pr ?? ''}`;
  const entryCache = cache.get(key) ?? { readAt: 0 };
  cache.set(key, entryCache);
  if (entryCache.data && now - entryCache.readAt < config.dashboard.githubTtlSeconds * 1000 && entryCache.readAt >= changedSince) return entryCache.data;

  if (!entryCache.reading) {
    entryCache.reading = fetchDetail(entry, ref)
      .then((data) => {
        entryCache.data = data;
        entryCache.readAt = Date.now();
        return data;
      })
      .catch((error) => {
        log.error(`tablero: no se pudo leer ${key} de GitHub`, error);
        entryCache.readAt = Date.now();
        entryCache.data = { ...(entryCache.data ?? { fetchedAt: '' }), error: (error as Error).message.split('\n')[0] };
        return entryCache.data;
      })
      .finally(() => {
        entryCache.reading = undefined;
      });
  }
  return entryCache.data ?? entryCache.reading;
}

// After an action on one of the repo's items: its next read is fresh. Every
// item of the repo, since an issue's page carries its PR too.
export function forgetDetails(repo: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${repo}#`)) cache.delete(key);
}

export function resetDetailCache(): void {
  cache.clear();
}
