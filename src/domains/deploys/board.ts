import { config } from '../../core/config.js';
import { withResourceLock } from '../../core/locks.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { DeployError, followDeploys, listDeploys, pendingChanges, planRelease, problemText, publishRelease, readRepo, type DeployRecord, type RepoRead, type Pending, type PendingChange, type Plan, type ReleaseRequest } from './index.js';

// The dashboard's deploys (#158): each repo with `deploy` in repos.json,
// what's merged and not deployed yet, its last releases and how their
// workflow went, and the dialog's plan and publish — all through deploy/,
// which knows nothing of the dashboard. Admins only (apps/api/http/dashboard.ts).

export class DespliegueError extends Error {
  constructor(message: string, readonly status = 400, readonly plan?: unknown) {
    super(message);
  }

  // With the plan as it is now, when it changed under the person (a
  // fingerprint that no longer matches).
  get details() {
    return this.plan ? { plan: this.plan } : {};
  }
}

// The last releases a repo's card shows.
const RELEASES_SHOWN = 8;

const changeView = (c: PendingChange) => ({ sha: c.sha, subject: c.subject, pr: c.pr, apps: c.apps, pedidos: c.pedidos });
const pendingView = (p: Pending) => ({ base: p.base?.tag ?? null, head: p.head, changes: p.changes.map(changeView) });
const deployView = (d: DeployRecord) => ({ state: d.state, mode: d.mode, by: d.by, at: d.at, pedidos: d.pedidos, changes: d.changes.length, runs: d.runs ?? [], ...(d.releaseError ? { releaseError: d.releaseError } : {}) });

export function planView(plan: Plan) {
  return {
    tag: plan.tag,
    prerelease: plan.prerelease,
    mode: plan.mode,
    base: plan.base?.tag ?? null,
    target: plan.target,
    changes: plan.changes.map(changeView),
    apps: plan.apps,
    notes: plan.notes,
    problems: plan.problems,
    messages: plan.problems.map(problemText),
    fingerprint: plan.fingerprint,
  };
}

// What readRepo read of each repo (a fetch and two GitHub calls, 1 to 3 s),
// kept for DASHBOARD_GITHUB_TTL_SECONDS: the page asks again every 10 to 30 s
// while open. Older than that, the previous read is served while the next one
// is on its way, as the dashboard's GitHub cache does. A publish forgets it,
// so the new release shows on the next read. The plan and the publish always
// read fresh (deploy.ts).
const reads = new Map<string, { data?: RepoRead; readAt: number; reading?: Promise<RepoRead> }>();

function cachedRead(repo: string, now = Date.now()): Promise<RepoRead> {
  const entry = reads.get(repo) ?? { readAt: 0 };
  reads.set(repo, entry);
  if (entry.data && now - entry.readAt < config.dashboard.githubTtlSeconds * 1000) return Promise.resolve(entry.data);
  entry.reading ??= readRepo()
    .then((data) => {
      entry.data = data;
      entry.readAt = Date.now();
      return data;
    })
    .finally(() => {
      entry.reading = undefined;
    });
  if (!entry.data) return entry.reading;
  // Its failure is the next request's to see, if there's no newer read by then.
  entry.reading.catch((error) => log.error(`tablero: no se pudieron leer los despliegues de ${repo}`, error));
  return Promise.resolve(entry.data);
}

export function resetDespliegueReads(): void {
  reads.clear();
}

// One repo's card. A deploy still going is followed right here too, so the
// page doesn't wait for the tick or the webhook to see it end.
async function repoView(entry: RepoEntry) {
  return withActiveRepo(entry, async () => {
    if ((await listDeploys(entry.productRepo)).some((d) => d.state === 'running')) {
      await withResourceLock('deploys', 'skip', () => followDeploys()).catch((error) => log.error('tablero: no se pudieron seguir los despliegues', error));
    }
    // One fetch and one read of GitHub for both kinds of release and the releases shown.
    const read = await cachedRead(entry.productRepo);
    const [pending, prePending, records] = await Promise.all([
      pendingChanges({}, read),
      entry.deploy?.prerelease ? pendingChanges({ prerelease: true }, read) : null,
      listDeploys(entry.productRepo),
    ]);
    const releases = read.releases.filter((r) => !r.isDraft).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const latest = releases.find((r) => !r.isPrerelease)?.tagName;
    const shown = releases.slice(0, RELEASES_SHOWN).map((r) => {
      const record = records.find((d) => d.tag === r.tagName);
      return { tag: r.tagName, name: r.name, at: r.publishedAt, prerelease: r.isPrerelease, latest: r.tagName === latest, url: r.url, ...(record ? { deploy: deployView(record) } : {}) };
    });
    // A tag ronin pushed whose release couldn't be created: GitHub doesn't list it.
    const orphans = records.filter((d) => d.releaseError && !releases.some((r) => r.tagName === d.tag)).map((d) => ({ tag: d.tag, name: d.tag, at: d.at, prerelease: d.prerelease, latest: false, url: '', deploy: deployView(d) }));
    return {
      repo: entry.productRepo,
      branch: pending.branch,
      prerelease: Boolean(entry.deploy?.prerelease),
      selective: Boolean(entry.deploy?.selective),
      pending: pendingView(pending),
      ...(prePending ? { prePending: pendingView(prePending) } : {}),
      releases: [...orphans, ...shown],
    };
  });
}

export async function despliegues(entries: RepoEntry[]) {
  return Promise.all(entries.filter((e) => e.deploy).map((entry) => repoView(entry).catch((error) => {
    log.error(`tablero: no se pudieron leer los despliegues de ${entry.productRepo}`, error);
    return { repo: entry.productRepo, error: (error as Error).message.split('\n')[0] };
  })));
}

export interface ReleaseBody extends ReleaseRequest {
  title?: string;
  notes?: string;
  fingerprint?: string;
}

export function parseRelease(body: Record<string, unknown>): ReleaseBody {
  const { tag, prs, prerelease, title, notes, fingerprint } = body;
  if (typeof tag !== 'string' || !tag.trim()) throw new DespliegueError('falta el tag');
  if (prs !== 'all' && !(Array.isArray(prs) && prs.every((n) => Number.isInteger(n) && n > 0))) throw new DespliegueError('prs debe ser "all" o una lista de números de PR');
  if (prerelease !== undefined && typeof prerelease !== 'boolean') throw new DespliegueError('prerelease debe ser true o false');
  for (const [name, value] of Object.entries({ title, notes, fingerprint })) {
    if (value !== undefined && typeof value !== 'string') throw new DespliegueError(`${name} debe ser un texto`);
  }
  if (typeof notes === 'string' && notes.length > 20_000) throw new DespliegueError('las notas son demasiado largas');
  return {
    tag: tag.trim(),
    prs: prs as ReleaseBody['prs'],
    ...(prerelease !== undefined ? { prerelease } : {}),
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof notes === 'string' ? { notes } : {}),
    ...(typeof fingerprint === 'string' ? { fingerprint } : {}),
  };
}

export async function planDespliegue(entry: RepoEntry, body: ReleaseBody) {
  return withActiveRepo(entry, async () => {
    try {
      return planView(await planRelease(body));
    } catch (error) {
      if (error instanceof DeployError) throw new DespliegueError(error.message);
      throw error;
    }
  });
}

export async function publishDespliegue(entry: RepoEntry, body: ReleaseBody, login: string) {
  return withActiveRepo(entry, async () => {
    try {
      const record = await publishRelease({ ...body, by: login }).finally(() => reads.delete(entry.productRepo));
      return { tag: record.tag, url: record.url, pedidos: record.pedidos };
    } catch (error) {
      if (error instanceof DeployError) throw new DespliegueError(error.message, 409, error.plan ? planView(error.plan) : undefined);
      throw error;
    }
  });
}
