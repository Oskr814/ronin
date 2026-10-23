import { config } from '@platform/config/config.js';
import { listFileReviewComments } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { EXPLORATION_DIR, parseFinding, type FindingMeta } from './memory.js';
import { parseFindingBody, type FindingBodyParts, type FindingImage } from './output.js';
import { EXPLORATION_BRANCH_PREFIX, findingsAddedOverBase } from './pr.js';
import { host } from '@platform/host/host.js';
import { ReadCache } from '@platform/cache/read-cache.js';


// The review of an exploration PR on the dashboard (#93): the findings the
// PR brings, each read into its parts (what happens, before and after, the
// proposal), with its own review thread — so the PR can be reviewed without
// going through "Files changed", where the findings are diffs of markdown
// and inventory.yml, knowledge.md and runs/ get in the way.
//
// The findings are read from the product repo's own clone, at the PR's
// branch, as runs/evidence.ts reads the screenshots; the threads come
// from GitHub. Cached like an item's page (items/detail.ts).

export interface FindingCardComment {
  id: number;
  replyTo?: number;
  author: string;
  body: string;
  createdAt?: string;
  url?: string;
}

export interface FindingCard extends FindingBodyParts {
  app: string;
  id: string;
  tipo: FindingMeta['tipo'];
  titulo: string;
  funcion: string;
  senal: FindingMeta['senal'];
  gravedad: FindingMeta['gravedad'];
  charter: FindingMeta['charter'];
  viewport: FindingMeta['viewport'];
  rol: string;
  estado: FindingMeta['estado'];
  motivo?: string;
  // Who decided it in the review (GitHub login), and when.
  revisor?: string;
  revisado?: string;
  issue?: number;
  entorno?: boolean;
  // The file in the PR's branch: its path, where a comment on it goes, and on GitHub.
  path: string;
  url: string;
  // The after it had before ronin redid it, when it did.
  previousAfterImage?: FindingImage;
  comments: FindingCardComment[];
}

export interface ExplorationReview {
  fetchedAt: string;
  branch: string;
  base: string;
  fichas: FindingCard[];
  runs: Array<{ app: string; id: string; url: string }>;
  error?: string;
}

export interface ExplorationPr {
  number: number;
  headRefName: string;
  baseRefName: string;
}

export const isExplorationPr = (pr: { headRefName: string }) => pr.headRefName.startsWith(EXPLORATION_BRANCH_PREFIX);

const FINDING_PATH_RE = new RegExp(`^${EXPLORATION_DIR}/([^/]+)/findings/(F-\\d+)[^/]*\\.md$`);
const RUN_PATH_RE = new RegExp(`^${EXPLORATION_DIR}/([^/]+)/runs/([^/]+)\\.md$`);
// How far back a finding's history is looked at for its previous after.
const HISTORY_COMMITS = 12;
// A branch is fetched at most this often per repo.
const FETCH_EVERY_MS = 60_000;
const lastFetch = new Map<string, number>();

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await host().exec('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean);
const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`;

async function fetchBranches(dir: string, branches: string[]): Promise<void> {
  const key = `${dir}:${branches.join(',')}`;
  if (Date.now() - (lastFetch.get(key) ?? 0) < FETCH_EVERY_MS) return;
  lastFetch.set(key, Date.now());
  // A branch already deleted (the PR merged) leaves what the clone had.
  await git(dir, ['fetch', '-q', 'origin', ...branches.map((b) => `+refs/heads/${b}:${remoteRef(b)}`)]).catch(() => {});
}

// A file at a branch of the product repo's clone, as it is on GitHub (the
// branch fetched at most once a minute); null when the branch or the file
// isn't there. For the inventory on the Exploraciones page (#155).
export async function readBranchFile(entry: RepoEntry, branch: string, path: string): Promise<string | null> {
  const dir = entry.productRepoPath;
  await fetchBranches(dir, [branch]);
  return git(dir, ['show', `${remoteRef(branch)}:${path}`]).catch(() => null);
}

// The finding's after in each earlier version on the branch, newest first:
// the first one that isn't the current is the one ronin replaced.
async function previousAfter(dir: string, base: string, head: string, path: string, current: string | undefined): Promise<FindingImage | undefined> {
  if (!current) return undefined;
  const log = await git(dir, ['log', `-${HISTORY_COMMITS}`, '--follow', '--name-only', '--format=%x00%H', `${base}..${head}`, '--', path]).catch(() => '');
  for (const block of log.split('\0').slice(1)) {
    const [sha, file] = lines(block);
    if (!sha || !file) continue;
    const raw = await git(dir, ['show', `${sha}:${file}`]).catch(() => '');
    const after = raw ? parseFindingBody(parseFinding(raw).body).despues : undefined;
    if (after && after.url !== current) return after;
  }
  return undefined;
}

async function readFindingCards(entry: RepoEntry, pr: ExplorationPr): Promise<Omit<ExplorationReview, 'fetchedAt'>> {
  const dir = entry.productRepoPath;
  await fetchBranches(dir, [pr.headRefName, pr.baseRefName]);
  const head = remoteRef(pr.headRefName);
  const base = remoteRef(pr.baseRefName);
  const changed = lines(await git(dir, ['diff', '--name-only', `${base}...${head}`, '--', EXPLORATION_DIR]));
  const apps = [...new Set(changed.map((f) => f.split('/')[2]).filter(Boolean))].sort();
  const blob = (path: string) => `https://github.com/${entry.productRepo}/blob/${pr.headRefName.split('/').map(encodeURIComponent).join('/')}/${path}`;

  const cards: Array<Omit<FindingCard, 'comments'>> = [];
  for (const app of apps) {
    const findingsDir = `${EXPLORATION_DIR}/${app}/findings`;
    const baseFiles = lines(await git(dir, ['ls-tree', '-r', '--name-only', base, '--', findingsDir]).catch(() => ''));
    const added = findingsAddedOverBase(changed.filter((f) => f.startsWith(`${EXPLORATION_DIR}/${app}/`)), baseFiles);
    if (added.size === 0) continue;
    for (const path of lines(await git(dir, ['ls-tree', '-r', '--name-only', head, '--', findingsDir]))) {
      const match = FINDING_PATH_RE.exec(path);
      if (!match || !added.has(match[2])) continue;
      try {
        const { body, huella: _huella, semilla: _semilla, fecha: _fecha, ...meta } = parseFinding(await git(dir, ['show', `${head}:${path}`]));
        const parts = parseFindingBody(body);
        const previousAfterImage = await previousAfter(dir, base, head, path, parts.despues?.url);
        cards.push({ app, ...meta, ...parts, path, url: blob(path), ...(previousAfterImage ? { previousAfterImage } : {}) });
      } catch (error) {
        log.error(`tablero: no se pudo leer la ficha ${path} de #${pr.number}`, error);
      }
    }
  }
  const runs = changed.flatMap((f) => {
    const m = RUN_PATH_RE.exec(f);
    return m ? [{ app: m[1], id: m[2], url: blob(f) }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));

  // The threads, by app and id rather than path: an edited title renames the file.
  const byFindingCard = new Map<string, FindingCardComment[]>();
  let error: string | undefined;
  try {
    const all = await withActiveRepo(entry, () => listFileReviewComments(pr.number));
    for (const c of all) {
      const m = FINDING_PATH_RE.exec(c.path);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      const list = byFindingCard.get(key) ?? [];
      list.push({ id: c.id, ...(c.inReplyToId ? { replyTo: c.inReplyToId } : {}), author: c.authorLogin, body: c.body, ...(c.createdAt ? { createdAt: c.createdAt } : {}), ...(c.url ? { url: c.url } : {}) });
      byFindingCard.set(key, list);
    }
  } catch (e) {
    error = `no se pudieron leer los comentarios: ${(e as Error).message.split('\n')[0]}`;
    log.error(`tablero: no se pudieron leer los comentarios de #${pr.number}`, e);
  }
  return {
    branch: pr.headRefName,
    base: pr.baseRefName,
    fichas: cards
      .sort((a, b) => a.app.localeCompare(b.app) || a.id.localeCompare(b.id))
      .map((f) => ({ ...f, comments: (byFindingCard.get(`${f.app}/${f.id}`) ?? []).sort((a, b) => a.id - b.id) })),
    runs,
    ...(error ? { error } : {}),
  };
}

const cache = new ReadCache<ExplorationReview>({
  label: (key) => `la exploración de ${key}`,
  ttlMs: () => config.dashboard.githubTtlSeconds * 1000,
  forgetMs: 30 * 60_000,
  failed: (previous, error) => ({ ...(previous ?? { fetchedAt: '', branch: '', base: '', fichas: [], runs: [] }), error }),
});

export function explorationReview(entry: RepoEntry, pr: ExplorationPr, changedSince = 0, now = Date.now()): Promise<ExplorationReview> {
  const key = `${entry.productRepo}#${pr.number}:${pr.headRefName}`;
  const read = async () => ({ fetchedAt: new Date().toISOString(), ...(await readFindingCards(entry, pr)) });
  const failed = (previous: ExplorationReview | undefined, error: string) => ({ ...(previous ?? { fetchedAt: '', branch: pr.headRefName, base: pr.baseRefName, fichas: [], runs: [] }), error });
  return cache.get(key, read, { tags: [entry.productRepo, `${entry.productRepo}#${pr.number}`], changedSince, now, failed });
}

// After someone commented from the dashboard: read again right away, and
// the next request waits for it, so it brings the comment. A webhook's
// doesn't wait.
export function expireExploration(repo: string, prNumber: number, { wait = false }: { wait?: boolean } = {}): void {
  cache.expire(`${repo}#${prNumber}`, { wait });
}

export function resetExplorationCache(): void {
  cache.clear();
  lastFetch.clear();
}
