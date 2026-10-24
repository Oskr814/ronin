import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { listBlockEvents } from './blocks.js';
import { readRepoData, syncRepo, type RepoData } from './collect.js';
import { computeMetrics, PERIODS, type Period } from './compute.js';
import { computeRequestMetrics } from './requests.js';
import { listUsers } from '../portal/accounts.js';
import { listRequests } from '../portal/requests.js';

export { PERIODS, type Period } from './compute.js';
export { recordBlockEvent } from './blocks.js';

// The dashboard's Métricas (#222): each repo read from GitHub at most every
// FRESH_MS, whoever asks; while a read is on its way the previous one is
// served, and a read that fails leaves the previous one with its error.
const FRESH_MS = 10 * 60_000;

interface Entry { data: RepoData | null; readAt: number; error?: string; reading?: Promise<void> }
const cache = new Map<string, Entry>();

async function repoData(repo: string, now: number): Promise<{ data: RepoData | null; error?: string }> {
  let entry = cache.get(repo);
  if (!entry) {
    entry = { data: await readRepoData(repo).catch(() => null), readAt: 0 };
    cache.set(repo, entry);
  }
  const current = entry;
  if (now - current.readAt >= FRESH_MS && !current.reading) {
    current.reading = syncRepo(repo)
      .then((data) => { current.data = data; current.error = undefined; })
      .catch((error) => {
        log.error(`métricas: no se pudo leer GitHub para ${repo}`, error);
        current.error = (error as Error).message.split('\n')[0];
      })
      .finally(() => { current.readAt = Date.now(); current.reading = undefined; });
  }
  // The first read ever is waited for; after that, the previous one is served.
  if (!current.data && current.reading) await current.reading;
  return { data: current.data, ...(current.error ? { error: current.error } : {}) };
}

export async function metricsView(repos: string[], days: Period, repo: string | null, now = Date.now()) {
  const shown = repo ? repos.filter((r) => r === repo) : repos;
  const [read, blocks] = await Promise.all([
    Promise.all(shown.map(async (r) => ({ repo: r, ...(await repoData(r, now)) }))),
    listBlockEvents().catch((error) => {
      log.error('métricas: no se pudo leer el registro de bloqueos', error);
      return [];
    }),
  ]);
  const data = read.flatMap((r) => (r.data ? [r.data] : []));
  return {
    repos,
    repo,
    sources: read.map((r) => ({ repo: r.repo, syncedAt: r.data?.syncedAt ?? null, ...(r.error ? { error: r.error } : {}) })),
    ...computeMetrics({ repos: data, blocks, ronin: config.githubLogin, days, now }),
  };
}

// Métricas → Pedidos (#428): the portal's requests of the repos shown, with
// a big one's owner from the same GitHub data.
export async function requestMetricsView(repos: string[], days: Period, repo: string | null, now = Date.now()) {
  const shown = repo ? repos.filter((r) => r === repo) : repos;
  const [requests, users, data] = await Promise.all([listRequests(), listUsers(), repoDataOf(shown, now)]);
  const issues = new Map(data.flatMap((d) => Object.values(d.issues).map((i) => [`${d.repo}#${i.number}`, i.assignees] as const)));
  return {
    repos,
    repo,
    ...computeRequestMetrics({
      requests: requests.filter((r) => shown.includes(r.repo)),
      people: new Map(users.map((u) => [u.id, u.name])),
      assignees: (r, n) => issues.get(`${r}#${n}`) ?? [],
      days,
      now,
    }),
  };
}

// What Métricas has of each repo, read the same way (Suscripción, #234).
export async function repoDataOf(repos: string[], now = Date.now()): Promise<RepoData[]> {
  const read = await Promise.all(repos.map((r) => repoData(r, now)));
  return read.flatMap((r) => (r.data ? [r.data] : []));
}

export function parsePeriod(value: string | null): Period | null {
  const n = Number(value ?? 30);
  return (PERIODS as number[]).includes(n) ? (n as Period) : null;
}

export function resetMetricsCache(): void {
  cache.clear();
}
