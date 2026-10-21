import { config } from '../../platform/config/config.js';
import { accountName, listUsage } from '../../platform/claude/claude-usage.js';
import { itemKindOf } from '../../platform/github/github.js';
import { slotsInUseDb, waitingDb } from '../../platform/locks/locks-db.js';
import { withActiveRepo, type RepoEntry } from '../../platform/agents/repo-context.js';
import { loadRepos } from '../../platform/config/repos.js';
import type { RunSummary } from '../../platform/agents/run-record.js';
import { timed } from '../../platform/timing.js';
import { getDb } from '../../platform/db/db.js';
import { listMeetings } from '../meetings/index.js';
import { listUsers, type PortalUser } from '../portal/accounts.js';
import { listRequests } from '../portal/requests.js';
import { sees, type Access } from '../access/access.js';
import { listActions } from './actions.js';
import { HISTORY_DAYS, hostLoad, itemKey, readQueue, readTickInfo, slotsInUse } from '../runs/data.js';
import { itemDetail, resolveItem } from './detail.js';
import { explorationReview, isExplorationPr } from '../explorations/review.js';
import { exploracionRows, liveRuns, prsOf } from '../explorations/board.js';
import { prFiles } from './files.js';
import { repoGithub } from './github.js';
import { buildItems, itemRunKeys } from './list.js';
import { cycleView, repoLinear } from './linear.js';
import { repoAppPaths, repoApps } from './new-issue.js';
import { isOpen, requestRow } from '../portal/board.js';
import { today, WEEK_DAYS } from './today.js';
import { can } from '../access/team.js';
import { visibleRepos, visibleRuns } from '../access/visible.js';
import { missingPortalConfig } from '../portal/http.js';

// What the dashboard reads of the repos a session sees (#65): the sidebar
// and the status bar (snapshot), Hoy, and each item with what GitHub has on
// it. Every read takes the session's access (#106, access/access.ts), so it never
// reaches a repo the person can't see on GitHub. domains/items/routes.ts answers
// with it.

// How far back the sidebar looks. Run records are kept 14 days.
const SIDEBAR_DAYS = 3;

// Every repo's GitHub and Linear read, started when the server comes up:
// otherwise the first visit after a restart (each deploy) waited for all of
// it — 7 s on 2026-10-20. A failed read stays in its cache, as any read's does.
export async function warmDashboard(): Promise<void> {
  await Promise.all((await loadRepos()).map(async (entry) => repoLinear(entry, await repoGithub(entry))));
}

// What waits for a slot: from Postgres with DATABASE_URL (platform/locks/locks-db.ts).
async function waitingQueue() {
  const db = getDb();
  return db ? timed('db', () => waitingDb(db)) : readQueue();
}

// Each repo's agent slots, taken and its limit (its own queue, platform/locks/locks.ts),
// and the sum of them for the status bar.
async function slotsView(entries: RepoEntry[]) {
  const db = getDb();
  const used = db ? await timed('db', () => slotsInUseDb(db)) : slotsInUse();
  const repos = entries.map((entry) => ({ repo: entry.productRepo, used: used[entry.productRepo] ?? 0, limit: entry.concurrency ?? config.tickConcurrency }));
  return { used: repos.reduce((n, r) => n + r.used, 0), limit: repos.reduce((n, r) => n + r.limit, 0), repos };
}

export async function snapshot(access: Access, login: string): Promise<unknown> {
  const entries = await visibleRepos(access);
  const repos = entries.map((repo) => repo.productRepo);
  const runs = await visibleRuns(access, SIDEBAR_DAYS);
  // A repo's GitHub read is stale once one of its runs started or ended after it.
  const changedSince = (repo: string) => Math.max(0, ...runs.filter((run) => run.repo === repo).map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const github = await Promise.all(entries.map((entry) => repoGithub(entry, changedSince(entry.productRepo))));
  const linear = await Promise.all(entries.map((entry, i) => repoLinear(entry, github[i])));
  // Each issue ronin manages, with its Linear issue: identifier, state, project, cycle.
  const items = buildItems(repos, runs, github).map((item) => {
    const issue = item.kind === 'issue' && item.number !== undefined ? linear[repos.indexOf(item.repo)]?.issues[item.number] : undefined;
    return issue ? { ...item, linear: issue } : item;
  });
  return {
    me: login,
    // Whether it sees everything, and through which permission it sees each repo.
    access: { admin: access.admin, repos: access.repos },
    // ronin's GitHub login, for the comments the page shows it'll write.
    ronin: config.githubLogin,
    // Whether it can manage the request portal's accounts (#114).
    portalAdmin: access.admin && missingPortalConfig(config.portal).length === 0,
    // The portal's requests still going, for the sidebar, and how many there are in all (#132).
    ...(await portalSummary(access, runs)),
    // The meetings that wait on someone to review what ronin proposed (#62).
    reunionesPorRevisar: (await visibleMeetings(access)).filter((m) => m.status === 'review').length,
    repos,
    // The queue and the Claude accounts, only of the repos it sees.
    runner: { slots: await slotsView(entries), queue: (await waitingQueue()).filter((job) => !job.repo || repos.includes(job.repo)), tick: readTickInfo(), host: hostLoad() },
    usage: (await listUsage()).filter((u) => entries.some((entry) => accountName(entry.claudeConfigDir ?? '') === u.account)),
    items,
    // Whether it can deploy (#158): an admin, with a repo that has deploy.
    despliegues: entries.some((entry) => entry.deploy && can(access, entry.productRepo, 'desplegar')),
    // Each app a repo explores, with its exploration PR and whether it runs now (#155).
    exploraciones: exploracionRows(entries, prsOf(entries, github), runs, await liveRuns(entries)),
    previews: github.flatMap((gh) => (gh ? gh.previews.map((p) => ({ ...p, repo: gh.repo })) : [])),
    github: github.map((gh, i) => ({ repo: repos[i], fetchedAt: gh?.fetchedAt ?? null, ...(gh?.error ? { error: gh.error } : {}) })),
    // Each repo's apps (ronin.app.json), for /spike and /spec on a new issue.
    apps: Object.fromEntries(await Promise.all(entries.map(async (entry) => [entry.productRepo, await repoApps(entry)] as const))),
    // Only the repos with a Linear key.
    linear: linear.flatMap((l) => (l ? [{
      repo: l.repo,
      ...(l.workspace ? { workspace: l.workspace } : {}),
      fetchedAt: l.fetchedAt || null,
      cycle: l.cycle ? { team: l.cycle.team, number: l.cycle.number, ...(l.cycle.name ? { name: l.cycle.name } : {}), startsAt: l.cycle.startsAt, endsAt: l.cycle.endsAt } : null,
      ...(l.planning ? { planning: l.planning } : {}),
      ...(l.error ? { error: l.error } : {}),
    }] : [])),
  };
}

// The portal's requests of the repos it sees, with whoever asked each.
async function visibleRequests(access: Access) {
  const requests = (await listRequests()).filter((r) => sees(access, r.repo));
  const users = new Map<string, PortalUser>(requests.length ? (await listUsers()).map((u) => [u.id, u]) : []);
  return { requests, users };
}

// The meetings of the repos it sees (#62).
async function visibleMeetings(access: Access) {
  return (await listMeetings()).filter((m) => sees(access, m.repo));
}

async function portalSummary(access: Access, runs: RunSummary[]) {
  const { requests, users } = await visibleRequests(access);
  const entries = await visibleRepos(access);
  return {
    pedidos: requests.filter(isOpen).map((r) => requestRow(r, users.get(r.userId), entries, runs)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    pedidosTotal: requests.length,
  };
}

// Hoy: the runs, and each repo's current Linear cycle, where ronin's issues
// stand by what GitHub says of them.
export async function todayWithCycles(access: Access): Promise<unknown> {
  const entries = await visibleRepos(access);
  const cycles = await Promise.all(entries.map(async (entry) => {
    const gh = await repoGithub(entry);
    const linear = await repoLinear(entry, gh);
    return linear ? cycleView(linear, gh) : null;
  }));
  return { ...today(await visibleRuns(access, WEEK_DAYS)), cycles: cycles.filter(Boolean) };
}

// An issue or PR of a repo in repos.json: what it is, and when one of its
// runs last started or ended. Null for an item that isn't one (a changelog entry).
async function itemRef(access: Access, id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  if (!match) return null;
  const entry = (await visibleRepos(access)).find((repo) => repo.productRepo === match[1]);
  if (!entry) return null;
  const gh = await repoGithub(entry);
  const keys = itemRunKeys(id, gh);
  const runs = (await visibleRuns(access, HISTORY_DAYS)).filter((run) => keys.includes(itemKey(run)));
  const changedSince = Math.max(0, ...runs.map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const runKind = runs[0] ? (runs[0].issueNumber !== undefined ? 'issue' : 'pr') : undefined;
  // Neither listed nor run on lately (opened by its number): GitHub says what it is.
  const number = Number(match[2]);
  const ref = resolveItem(number, gh, runKind) ?? resolveItem(number, undefined, (await withActiveRepo(entry, () => itemKindOf(number))) ?? undefined);
  return ref && { entry, ref, gh, changedSince };
}

// The item, with what GitHub has on it.
export async function itemContext(access: Access, id: string) {
  const ctx = await itemRef(access, id);
  return ctx && { ...ctx, detail: await itemDetail(ctx.entry, ctx.ref, ctx.changedSince) };
}

// The files of the item's PR: a PR's own, an issue's moving PR's. Null for
// an item with no PR.
export async function filesContext(access: Access, id: string) {
  const ctx = await itemRef(access, id);
  if (!ctx) return null;
  const prNumber = ctx.ref.kind === 'pr' ? ctx.ref.number : ctx.ref.pr;
  if (prNumber === undefined) return null;
  return { entry: ctx.entry, prNumber, files: await prFiles(ctx.entry, prNumber, ctx.changedSince) };
}

// The item's actions, with the repo's apps and where each one lives.
export async function actionsOf(ctx: NonNullable<Awaited<ReturnType<typeof itemContext>>>, login: string) {
  const paths = await repoAppPaths(ctx.entry);
  return listActions(ctx.ref, ctx.gh, ctx.detail, login, Object.keys(paths), paths);
}

export async function detail(access: Access, id: string, login: string): Promise<unknown | null> {
  const ctx = await itemContext(access, id);
  if (!ctx) return null;
  // `ronin`: its login, so the page can tell its comments apart. `exploration`:
  // an exploration PR, whose page has its findings to review (#93).
  const pr = ctx.ref.kind === 'pr' ? ctx.gh?.prs.find((p) => p.number === ctx.ref.number) : undefined;
  return { ref: ctx.ref, ronin: config.githubLogin, ...ctx.detail, exploration: Boolean(pr && isExplorationPr(pr)), actions: await actionsOf(ctx, login), pedido: await pedidoOf(ctx.entry.productRepo, ctx.ref) };
}

// The portal request an issue or PR came from (#132), to link its page.
async function pedidoOf(repo: string, ref: { kind: string; number: number; issue?: number; pr?: number }) {
  const issue = ref.kind === 'issue' ? ref.number : ref.issue;
  const pr = ref.kind === 'pr' ? ref.number : ref.pr;
  const request = (await listRequests()).find((r) => r.repo === repo && ((issue !== undefined && r.issue?.number === issue) || (pr !== undefined && r.pr === pr)));
  return request ? { number: request.number, title: request.title } : null;
}

// An open exploration PR of a repo in repos.json, with its findings. Null
// for anything else.
export async function explorationContext(access: Access, id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  const entry = match && (await visibleRepos(access)).find((repo) => repo.productRepo === match[1]);
  if (!match || !entry) return null;
  const gh = await repoGithub(entry);
  const pr = gh?.prs.find((p) => p.number === Number(match[2]));
  if (!pr || !isExplorationPr(pr)) return null;
  const keys = itemRunKeys(id, gh);
  const changedSince = Math.max(0, ...(await visibleRuns(access, HISTORY_DAYS)).filter((run) => keys.includes(itemKey(run))).map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  return { entry, pr, review: await explorationReview(entry, pr, changedSince) };
}

export async function exploration(access: Access, id: string): Promise<unknown | null> {
  const ctx = await explorationContext(access, id);
  return ctx && { ronin: config.githubLogin, ...ctx.review };
}
