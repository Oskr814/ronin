import { config } from '@platform/config/config.js';
import { getItemDiscussions, type Discussion } from '@platform/github/github.js';
import { prQuestions, type PrQuestion } from '@platform/github/pr-body.js';
import { linearRefFrom, type LinearRef } from '@platform/linear/linear.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { ReadCache } from '@platform/cache/read-cache.js';
import type { RepoGithub } from './github.js';

// An item's page in the dashboard (#85): the issue's and the PR's bodies,
// each with its conversation (comments; a PR's reviews and review threads too), so the center has something to show whether or
// not an agent ran on it. An issue brings the slice PR that's moving; a
// slice PR, its tracking issue.
//
// Read only when an item is opened, never for the sidebar, and cached like
// the repo reads (items/github.ts): DASHBOARD_GITHUB_TTL_SECONDS, or
// sooner when one of the item's runs started or ended since, or a write or a
// webhook changed it (expireDetails).

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
  // The issue's Linear issue, from the Linear bot's comment on it (#101).
  linear?: LinearRef;
  // The questions ronin's internal review left in its PR's description
  // (#194), with their suggested answers: the page asks them.
  questions?: PrQuestion[];
  error?: string;
}

const SLICE_BRANCH = /^ronin\/(\d+)\//;

// What `number` is in this repo, from the cached repo read: an open issue
// brings its moving PR (a ronin issue's lowest open slice, anyone else's
// first open PR); an open PR, the issue it belongs to (#100). `runKind`: what
// its runs say it is, for one GitHub doesn't list (a closed issue, a merged PR).
export function resolveItem(number: number, gh: RepoGithub | undefined, runKind?: 'issue' | 'pr'): ItemRef | null {
  const own = gh?.issues.find((i) => i.number === number);
  if (own || gh?.openIssues.some((i) => i.number === number)) {
    const open = new Set(gh!.prs.map((pr) => pr.number));
    const moving = own
      ? own.slices.find((s) => !s.checked && s.prNumber !== null && open.has(s.prNumber))?.prNumber
      : gh!.prs.find((pr) => gh!.prIssue[pr.number] === number)?.number;
    return { kind: 'issue', number, ...(moving ? { pr: moving } : {}) };
  }
  const pr = gh?.prs.find((p) => p.number === number);
  if (pr) {
    const tracking = gh!.prIssue[number] ?? Number(SLICE_BRANCH.exec(pr.headRefName)?.[1] ?? NaN);
    return { kind: 'pr', number, ...(Number.isInteger(tracking) ? { issue: tracking } : {}) };
  }
  // A merged (or closed) slice's PR, still its issue's.
  const sliced = gh?.issues.find((i) => i.slices.some((s) => s.prNumber === number));
  if (sliced) return { kind: 'pr', number, issue: sliced.number };
  return runKind ? { kind: runKind, number } : null;
}

const MAX_COMMENTS = 50;

async function fetchDetail(entry: RepoEntry, ref: ItemRef): Promise<ItemDetail> {
  return withActiveRepo(entry, async () => {
    const issueNumber = ref.kind === 'issue' ? ref.number : ref.issue;
    const prNumber = ref.kind === 'pr' ? ref.number : ref.pr;
    // Both in one query (#368).
    const { issue, pr } = await getItemDiscussions(issueNumber, prNumber);
    // Each half with its own conversation, shown on its own tab: the issue's
    // comments under the issue, the PR's comments and reviews under the PR.
    const trim = (d: Discussion): Discussion => ({ ...d, comments: d.comments.slice(-MAX_COMMENTS) });
    const linear = issue ? linearRefFrom(issue.comments) : null;
    const questions = pr ? prQuestions(pr.body) : [];
    return {
      fetchedAt: new Date().toISOString(),
      ...(linear ? { linear } : {}),
      ...(issue ? { issue: trim(issue) } : {}),
      ...(pr ? { pr: trim(pr) } : {}),
      ...(questions.length ? { questions } : {}),
    };
  });
}

// Items nobody opened in a while are dropped, so the cache doesn't grow with every item ever opened.
const cache = new ReadCache<ItemDetail>({
  label: (key) => key,
  ttlMs: () => config.dashboard.githubTtlSeconds * 1000,
  forgetMs: 30 * 60_000,
  failed: (previous, error) => ({ ...(previous ?? { fetchedAt: '' }), error }),
});

// Tagged with the repo and each number it shows: an issue's page carries its PR too.
export function itemDetail(entry: RepoEntry, ref: ItemRef, changedSince = 0, now = Date.now()): Promise<ItemDetail> {
  const repo = entry.productRepo;
  const key = `${repo}#${ref.kind}${ref.number}:${ref.issue ?? ''}:${ref.pr ?? ''}`;
  const numbers = [ref.number, ref.issue, ref.pr].filter((n): n is number => n !== undefined);
  return cache.get(key, () => fetchDetail(entry, ref), { tags: [repo, ...numbers.map((n) => `${repo}#${n}`)], changedSince, now });
}

// After a write to `number` (or, without it, to any of the repo's items):
// read again right away. `wait`: the next request waits for it — the person
// who wrote sees what they did; a webhook's doesn't.
export function expireDetails(repo: string, number?: number, { wait = false }: { wait?: boolean } = {}): void {
  cache.expire(number === undefined ? repo : `${repo}#${number}`, { wait });
}

// A comment just posted from the dashboard, on the pages that show `number`:
// there before the read that follows lands.
export function addDetailComment(repo: string, number: number, comment: Discussion['comments'][number]): void {
  cache.update(`${repo}#${number}`, (d) => ({
    ...d,
    ...(d.issue?.number === number ? { issue: { ...d.issue, comments: [...d.issue.comments, comment].slice(-MAX_COMMENTS) } } : {}),
    ...(d.pr?.number === number ? { pr: { ...d.pr, comments: [...d.pr.comments, comment].slice(-MAX_COMMENTS) } } : {}),
  }));
}

export function resetDetailCache(): void {
  cache.clear();
}
