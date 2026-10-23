import { config } from '@platform/config/config.js';
import { getDiffThreads, getFileAt, getPrFiles, type DiffThread, type PrFile } from '@platform/github/github.js';
import { pendingReview, viewedFiles, type PendingReview } from '@platform/github/github-as-user.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { ReadCache } from '@platform/cache/read-cache.js';

// A PR's "Files changed" on the dashboard (#111): its files with their
// patches, and its review threads where the diff puts them. Read with
// ronin's token when the Archivos tab is opened, never for the sidebar, and
// cached like an item's page (items/detail.ts): DASHBOARD_GITHUB_TTL_SECONDS,
// or sooner when one of the item's runs started or ended since, or a write or
// a webhook changed it (expireFiles).

export interface PrFiles {
  fetchedAt: string;
  prId: string;
  // Who opened the PR: they can't approve it or ask for changes on it.
  author: string;
  headSha: string;
  baseSha: string;
  files: PrFile[];
  threads: DiffThread[];
  error?: string;
}

async function fetchFiles(entry: RepoEntry, prNumber: number): Promise<PrFiles> {
  return withActiveRepo(entry, async () => {
    const [{ prId, author, headSha, baseSha, files }, threads] = await Promise.all([getPrFiles(prNumber), getDiffThreads(prNumber)]);
    return { fetchedAt: new Date().toISOString(), prId, author, headSha, baseSha, files, threads };
  });
}

// PRs nobody opened in a while are dropped, so the cache doesn't grow with every PR ever opened.
const cache = new ReadCache<PrFiles>({
  label: (key) => `los archivos de ${key}`,
  ttlMs: () => config.dashboard.githubTtlSeconds * 1000,
  forgetMs: 30 * 60_000,
  failed: (previous, error) => ({ ...(previous ?? { fetchedAt: '', prId: '', author: '', headSha: '', baseSha: '', files: [], threads: [] }), error }),
});

export function prFiles(entry: RepoEntry, prNumber: number, changedSince = 0, now = Date.now()): Promise<PrFiles> {
  const key = `${entry.productRepo}#${prNumber}`;
  return cache.get(key, () => fetchFiles(entry, prNumber), { tags: [entry.productRepo, key], changedSince, now });
}

// After a write to the PR (or, without it, to any of the repo's): read
// again right away; `wait` as in expireDetails.
export function expireFiles(repo: string, prNumber?: number, { wait = false }: { wait?: boolean } = {}): void {
  cache.expire(prNumber === undefined ? repo : `${repo}#${prNumber}`, { wait });
}

// Each person's own on a PR (#368): the files they marked as viewed and
// their pending review, read with their token. Cached per person and PR, so
// every tab of Archivos polling it doesn't read it each time; read again
// once that person writes on the PR (their next request waits for it) or a
// review of it comes in by webhook. A failed read fails the request, as
// before: none viewed isn't something to show on a guess.
export interface PersonFiles {
  viewed: string[];
  review: PendingReview | null;
}

const mine = new ReadCache<PersonFiles>({
  label: (key) => `lo de ${key}`,
  ttlMs: () => config.dashboard.githubTtlSeconds * 1000,
  forgetMs: 30 * 60_000,
  // The error as it came: a token GitHub no longer takes asks to log in again.
  failed: (previous, _message, error) => {
    if (previous) return previous;
    throw error;
  },
});

const personTag = (login: string, repo: string, prNumber: number) => `${login}:${repo}#${prNumber}`;

export function personFiles(token: string, login: string, repo: string, prNumber: number): Promise<PersonFiles> {
  const read = async () => {
    const [viewed, review] = await Promise.all([viewedFiles(token, repo, prNumber), pendingReview(token, repo, prNumber)]);
    return { viewed, review };
  };
  return mine.get(personTag(login, repo, prNumber), read, { tags: [personTag(login, repo, prNumber), `${repo}#${prNumber}`] });
}

// After the person wrote on the PR: their next request waits for a fresh read.
export function expirePersonFiles(login: string, repo: string, prNumber: number): void {
  mine.expire(personTag(login, repo, prNumber), { wait: true });
}

// A review of the PR came in: everyone's, read again for whoever has it open.
export function expireReviewsOf(repo: string, prNumber: number): void {
  mine.expire(`${repo}#${prNumber}`);
}

// A file's text at a commit, for "show more lines" around a hunk. A commit
// never changes, so what was read stays (the last MAX_CONTENTS of them).
const MAX_CONTENTS = 200;
// Past this the page offers GitHub instead of expanding.
export const MAX_CONTENT_BYTES = 1024 * 1024;
const contents = new Map<string, Promise<string | null>>();

export function fileContent(entry: RepoEntry, sha: string, path: string): Promise<string | null> {
  const key = `${entry.productRepo}@${sha}:${path}`;
  const known = contents.get(key);
  if (known) {
    // Most recently used goes last, so the oldest is the first to go.
    contents.delete(key);
    contents.set(key, known);
    return known;
  }
  const reading = withActiveRepo(entry, () => getFileAt(sha, path))
    .then((text) => (Buffer.byteLength(text) > MAX_CONTENT_BYTES ? null : text))
    .catch((error) => {
      contents.delete(key);
      throw error;
    });
  contents.set(key, reading);
  while (contents.size > MAX_CONTENTS) contents.delete(contents.keys().next().value!);
  return reading;
}

export function resetFilesCache(): void {
  cache.clear();
  mine.clear();
  contents.clear();
}
