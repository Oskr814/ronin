import { config, LABEL_DIRECT_ISSUE, LABEL_STATES } from '@platform/config/config.js';
import { listOpenIssues, listOpenManagedIssues, listOpenPrsWithChecks, listPrClosingIssues, listRecentlyClosed, type GithubState, type OpenIssue, type OpenPr } from '@platform/github/github.js';
import { getBlocks, type BlockRecord } from '@platform/state/local-state.js';
import { log } from '@platform/logger.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { ReadCache } from '@platform/cache/read-cache.js';
import { listPreviewStates } from '../previews/index.js';
import { parseSlices, type Slice } from '../slices/checklist.js';

// What the dashboard reads from GitHub (#65), per repo: the open issues ronin
// manages, with their bodies (the slice checklist); every open issue, for the
// search (#100); every open PR with its checks and the issues it closes; and
// how the latest closed ones closed (#129). Plus what this runner keeps about them: the
// reasons it blocked them (local state) and the previews it has up.
//
// Cached (platform/cache/read-cache.ts): several open tabs, each polling,
// never multiply GitHub's calls. A repo is read again after
// DASHBOARD_GITHUB_TTL_SECONDS, or sooner when one of its runs started or
// ended since the last read, or when a write from the dashboard or a webhook
// changed it (expireGithub). While a read is on its way, the previous one is
// served — the sidebar never waits for a whole read of the repo, only its
// very first one; if it fails, the previous one stays, with the error, so
// the page can say its GitHub data is old. The previews are the exception:
// they're files on this machine, read again on every call, so a preview
// whose data just got ready says so on the next poll.

export interface IssueView {
  number: number;
  title: string;
  url: string;
  status: 'in-progress' | 'blocked' | 'other';
  direct: boolean;
  slices: Slice[];
}

export interface PreviewView {
  prNumber: number;
  appName: string;
  url: string;
  startedAt?: string;
  expiresAt?: string;
  // Still making the PR's test data (preview.ts).
  preparing?: boolean;
  // The commit it's on, and whether it's moving to a newer one.
  sha: string;
  updating?: boolean;
}

export interface RepoGithub {
  repo: string;
  fetchedAt: string;
  issues: IssueView[];
  // Every open issue, ronin's included.
  openIssues: OpenIssue[];
  prs: OpenPr[];
  // The open issue each open PR belongs to, by PR number (linkPrs).
  prIssue: Record<number, number>;
  // How the latest closed issues and PRs closed, by number (#129).
  closed?: Record<number, GithubState>;
  previews: PreviewView[];
  blocks: Record<string, BlockRecord>;
  error?: string;
}

function issueStatus(labels: string[]): IssueView['status'] {
  if (labels.includes(LABEL_STATES.blocked)) return 'blocked';
  if (labels.includes(LABEL_STATES['in-progress'])) return 'in-progress';
  return 'other';
}

const BRANCH_NUMBER = /(?:^|[/_-])(\d+)(?=$|[/_-])/;

// The issue a PR belongs to (#100): the slice of a ronin issue it is, else
// the open issue it closes, else the open issue whose number its branch
// carries ("feat/405-algo", "valeria/228/slice-12"). A PR with none of those
// belongs to no issue.
export function linkPrs(prs: Array<Pick<OpenPr, 'number' | 'headRefName'>>, closing: Record<number, number[]>, issues: Array<Pick<IssueView, 'number' | 'slices'>>, open: Set<number>): Record<number, number> {
  const links: Record<number, number> = {};
  for (const pr of prs) {
    const slice = issues.find((i) => i.slices.some((s) => s.prNumber === pr.number));
    const closes = (closing[pr.number] ?? []).find((n) => open.has(n));
    const branch = Number(BRANCH_NUMBER.exec(pr.headRefName)?.[1]);
    const issue = slice?.number ?? closes ?? (open.has(branch) ? branch : undefined);
    if (issue !== undefined) links[pr.number] = issue;
  }
  return links;
}

async function fetchRepo(entry: RepoEntry): Promise<Omit<RepoGithub, 'previews'>> {
  return withActiveRepo(entry, async () => {
    const [managed, openIssues, prs, closing, closed, blocks] = await Promise.all([
      listOpenManagedIssues(), listOpenIssues(), listOpenPrsWithChecks(), listPrClosingIssues(),
      // Only for the icons: without it the dashboard still works.
      listRecentlyClosed().catch((error) => {
        log.error(`tablero: no se pudieron leer los cerrados de ${entry.productRepo}`, error);
        return {} as Record<number, GithubState>;
      }),
      getBlocks(),
    ]);
    const issues = managed.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      status: issueStatus(issue.labels),
      direct: issue.labels.includes(LABEL_DIRECT_ISSUE),
      slices: parseSlices(issue.body),
    }));
    return {
      repo: entry.productRepo,
      fetchedAt: new Date().toISOString(),
      issues,
      openIssues,
      prs,
      prIssue: linkPrs(prs, closing, issues, new Set([...openIssues, ...issues].map((i) => i.number))),
      closed,
      blocks,
    };
  });
}

async function readPreviews(entry: RepoEntry): Promise<PreviewView[]> {
  const ttl = config.previewTtlMinutes;
  try {
    const previews = await withActiveRepo(entry, () => listPreviewStates());
    return previews.map((p) => ({
      prNumber: p.prNumber,
      appName: p.appName,
      url: p.url,
      sha: p.sha,
      ...(p.updating ? { updating: true } : {}),
      ...(p.startedAt ? { startedAt: p.startedAt } : {}),
      ...(p.startedAt && ttl > 0 ? { expiresAt: new Date(Date.parse(p.startedAt) + ttl * 60_000).toISOString() } : {}),
      ...(p.preparing ? { preparing: true } : {}),
    }));
  } catch (error) {
    log.error(`tablero: no se pudieron leer las previews de ${entry.productRepo}`, error);
    return [];
  }
}

const cache = new ReadCache<Omit<RepoGithub, 'previews'>>({
  label: (repo) => `el repo ${repo}`,
  ttlMs: () => config.dashboard.githubTtlSeconds * 1000,
  failed: (previous, error) => ({ ...(previous ?? { fetchedAt: '', issues: [], openIssues: [], prs: [], prIssue: {}, closed: {}, blocks: {} }), repo: previous?.repo ?? '', error }),
});

// `changedSince`: the latest start or end of one of the repo's runs (epoch
// ms) — a read older than that is stale whatever its age.
export async function repoGithub(entry: RepoEntry, changedSince = 0, now = Date.now()): Promise<RepoGithub | undefined> {
  const key = entry.productRepo;
  const [github, previews] = await Promise.all([cache.get(key, () => fetchRepo(entry), { tags: [key], changedSince, now }), readPreviews(entry)]);
  return github && { ...github, repo: key, previews };
}

// After something changed the repo from the dashboard or GitHub said so (a
// webhook): read again right away, the previous read served meanwhile.
// `wait`: the next request waits for that read, for something the person
// is about to open (an issue they just created).
export function expireGithub(repo: string, { wait = false }: { wait?: boolean } = {}): void {
  cache.expire(repo, { wait });
}

// What a write already knows about the repo, in what's kept (a new issue in
// the list), so it shows before the read that follows lands.
export function updateGithub(repo: string, change: (github: Omit<RepoGithub, 'previews'>) => Omit<RepoGithub, 'previews'>): void {
  cache.update(repo, change);
}

// After the repo's settings changed: its next read is from scratch.
export function forgetGithub(repo: string): void {
  cache.forget(repo);
}

export function resetGithubCache(): void {
  cache.clear();
}
