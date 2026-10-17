import { config } from '../../core/config.js';
import { getDiffThreads, getFileAt, getPrFiles, type DiffThread, type PrFile } from '../../core/github.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';

// A PR's "Files changed" on the dashboard (#111): its files with their
// patches, and its review threads where the diff puts them. Read with
// ronin's token when the Archivos tab is opened, never for the sidebar, and
// cached like an item's page (dashboard-detail.ts): DASHBOARD_GITHUB_TTL_SECONDS,
// or sooner when one of the item's runs started or ended since.

export interface PrFiles {
  fetchedAt: string;
  prId: string;
  headSha: string;
  baseSha: string;
  files: PrFile[];
  threads: DiffThread[];
  error?: string;
}

async function fetchFiles(entry: RepoEntry, prNumber: number): Promise<PrFiles> {
  return withActiveRepo(entry, async () => {
    const [{ prId, headSha, baseSha, files }, threads] = await Promise.all([getPrFiles(prNumber), getDiffThreads(prNumber)]);
    return { fetchedAt: new Date().toISOString(), prId, headSha, baseSha, files, threads };
  });
}

const cache = new Map<string, { data?: PrFiles; readAt: number; reading?: Promise<PrFiles> }>();
// PRs nobody opened in a while are dropped, so the cache doesn't grow with every PR ever opened.
const FORGET_MS = 30 * 60_000;

export async function prFiles(entry: RepoEntry, prNumber: number, changedSince = 0, now = Date.now()): Promise<PrFiles> {
  for (const [key, value] of cache) if (!value.reading && now - value.readAt > FORGET_MS) cache.delete(key);
  const key = `${entry.productRepo}#${prNumber}`;
  const entryCache = cache.get(key) ?? { readAt: 0 };
  cache.set(key, entryCache);
  if (entryCache.data && now - entryCache.readAt < config.dashboard.githubTtlSeconds * 1000 && entryCache.readAt >= changedSince) return entryCache.data;

  if (!entryCache.reading) {
    entryCache.reading = fetchFiles(entry, prNumber)
      .then((data) => {
        entryCache.data = data;
        entryCache.readAt = Date.now();
        return data;
      })
      .catch((error) => {
        log.error(`tablero: no se pudieron leer los archivos de ${key} de GitHub`, error);
        entryCache.readAt = Date.now();
        entryCache.data = { ...(entryCache.data ?? { fetchedAt: '', prId: '', headSha: '', baseSha: '', files: [], threads: [] }), error: (error as Error).message.split('\n')[0] };
        return entryCache.data;
      })
      .finally(() => {
        entryCache.reading = undefined;
      });
  }
  return entryCache.data ?? entryCache.reading;
}

// After an action on one of the repo's PRs: its next read is fresh.
export function forgetFiles(repo: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${repo}#`)) cache.delete(key);
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
  contents.clear();
}
