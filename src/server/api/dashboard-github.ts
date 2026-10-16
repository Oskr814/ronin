import { config, LABEL_DIRECT_ISSUE, LABEL_STATES } from '../../core/config.js';
import { listOpenManagedIssues, listOpenPrsWithChecks, type OpenPr } from '../../core/github.js';
import { getBlocks, type BlockRecord } from '../../core/local-state.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { listPreviewStates } from '../../preview/index.js';
import { parseSlices, type Slice } from '../../slices/checklist.js';

// What the dashboard reads from GitHub (#65), per repo, in two calls: the
// open issues ronin manages, with their bodies (the slice checklist), and
// every open PR with its checks. Plus what this runner keeps about them: the
// reasons it blocked them (local state) and the previews it has up.
//
// Cached: several open tabs, each polling, never multiply GitHub's calls. A
// repo is read again after DASHBOARD_GITHUB_TTL_SECONDS, or sooner when one
// of its runs started or ended since the last read. While a read is on its
// way, the previous one is served; if it fails, the previous one stays, with
// the error, so the page can say its GitHub data is old.

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
}

export interface RepoGithub {
  repo: string;
  fetchedAt: string;
  issues: IssueView[];
  prs: OpenPr[];
  previews: PreviewView[];
  blocks: Record<string, BlockRecord>;
  error?: string;
}

function issueStatus(labels: string[]): IssueView['status'] {
  if (labels.includes(LABEL_STATES.blocked)) return 'blocked';
  if (labels.includes(LABEL_STATES['in-progress'])) return 'in-progress';
  return 'other';
}

async function fetchRepo(entry: RepoEntry): Promise<RepoGithub> {
  return withActiveRepo(entry, async () => {
    const [issues, prs, previews, blocks] = await Promise.all([listOpenManagedIssues(), listOpenPrsWithChecks(), listPreviewStates(), getBlocks()]);
    const ttl = config.previewTtlMinutes;
    return {
      repo: entry.productRepo,
      fetchedAt: new Date().toISOString(),
      issues: issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        status: issueStatus(issue.labels),
        direct: issue.labels.includes(LABEL_DIRECT_ISSUE),
        slices: parseSlices(issue.body),
      })),
      prs,
      previews: previews.map((p) => ({
        prNumber: p.prNumber,
        appName: p.appName,
        url: p.url,
        ...(p.startedAt ? { startedAt: p.startedAt } : {}),
        ...(p.startedAt && ttl > 0 ? { expiresAt: new Date(Date.parse(p.startedAt) + ttl * 60_000).toISOString() } : {}),
        ...(p.preparing ? { preparing: true } : {}),
      })),
      blocks,
    };
  });
}

const cache = new Map<string, { data?: RepoGithub; readAt: number; reading?: Promise<RepoGithub> }>();

// `changedSince`: the latest start or end of one of the repo's runs (epoch
// ms) — a read older than that is stale whatever its age.
export async function repoGithub(entry: RepoEntry, changedSince = 0, now = Date.now()): Promise<RepoGithub | undefined> {
  const key = entry.productRepo;
  const entryCache = cache.get(key) ?? { readAt: 0 };
  cache.set(key, entryCache);
  const fresh = entryCache.data && now - entryCache.readAt < config.dashboard.githubTtlSeconds * 1000 && entryCache.readAt >= changedSince;
  if (fresh) return entryCache.data;

  if (!entryCache.reading) {
    entryCache.reading = fetchRepo(entry)
      .then((data) => {
        entryCache.data = data;
        entryCache.readAt = Date.now();
        return data;
      })
      .catch((error) => {
        log.error(`tablero: no se pudo leer GitHub para ${key}`, error);
        // Tried again on the next snapshot, not on every one of them.
        entryCache.readAt = Date.now();
        const stale = entryCache.data ?? { repo: key, fetchedAt: '', issues: [], prs: [], previews: [], blocks: {} };
        entryCache.data = { ...stale, error: (error as Error).message.split('\n')[0] };
        return entryCache.data;
      })
      .finally(() => {
        entryCache.reading = undefined;
      });
  }
  // The first read is waited for; after that, the previous one is served meanwhile.
  return entryCache.data ?? entryCache.reading;
}

export function resetGithubCache(): void {
  cache.clear();
}
