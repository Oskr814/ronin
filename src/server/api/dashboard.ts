import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { config } from '../../core/config.js';
import { log } from '../../core/logger.js';
import { loadRepos } from '../../core/repos.js';
import { accountName } from '../../core/claude-usage.js';
import { sees, type Access } from './access.js';
import { itemKindOf } from '../../core/github.js';
import { withActiveRepo } from '../../core/repo-context.js';
import { itemKey, listRuns as listAllRuns, readQueue, readRunLines, readTickInfo, readUsage, runPath, slotsInUse, summarizeRun } from './dashboard-data.js';
import { forgetGithub, repoGithub } from './dashboard-github.js';
import { createFromDashboard, NewIssueError, parseNewIssue, repoApps } from './dashboard-new-issue.js';
import { cycleView, repoLinear } from './dashboard-linear.js';
import { buildItems, itemRunKeys } from './dashboard-items.js';
import { forgetDetails, itemDetail, resolveItem } from './dashboard-detail.js';
import { fileContent, forgetFiles, prFiles } from './dashboard-files.js';
import { FilesActionError, runFilesAction } from './dashboard-files-actions.js';
import { ActionError, listActions, runAction } from './dashboard-actions.js';
import { today, WEEK_DAYS } from './dashboard-today.js';
import { readEvidence } from './dashboard-evidence.js';
import { explorationReview, forgetExploration, isExplorationPr } from './dashboard-exploration.js';
import { FichaActionError, runApprove, runFichaAction, runGeneralComment } from './dashboard-exploration-actions.js';
import { GithubUserError, pendingReview, viewedFiles } from './github-as-user.js';
import type { Session } from './auth.js';
import { PortalAdminError, portalAdminView, runPortalAdmin, type PortalAdminContext } from './portal-admin.js';
import { AjustesError, ajustesView, linearTeams, readRegistro, saveNotificacion, saveProfile, setValue } from './ajustes.js';
import { can, touchSeen, type Perm } from './team.js';
import { addUsuario, removeUsuario, updateEquipo, updateUsuario, usuariosView, usuarioView } from './usuarios.js';
import { editRepo, reposView } from './repos-admin.js';
import { missingPortalConfig } from '../portal.js';
import { listUsers, type PortalUser } from '../../portal/accounts.js';
import { getRequest, listRequests } from '../../portal/requests.js';
import { isOpen, requestDetail, requestImage, requestPatch, requestRow } from './dashboard-portal.js';
import { DuplicateMeeting, createMeeting, getMeeting, launchMeetingWorker, listMeetings, retryMeeting } from '../../meetings/index.js';
import { MAX_UPLOAD_BODY, MeetingUploadError, meetingDetail, meetingOriginal, meetingRow, parseUpload } from './dashboard-meetings.js';
import { ApproveError, approveMeeting, discardMeeting } from './dashboard-meetings-approve.js';
import { DespliegueError, despliegues, parseRelease, planDespliegue, publishDespliegue } from './dashboard-despliegues.js';
import { ExploreNowError, corridasOf, exploracionList, exploracionRows, exploreNow, inventarioOf, liveRuns, parseExploreNow } from './dashboard-exploraciones.js';

// The dashboard's data (#65), all behind the session (tailnet.ts checks it
// before any of this runs):
//   GET /api/snapshot                the sidebar and the status bar
//   GET /api/today                   the last 12 hours' runs, the day's totals and the week's, and each repo's Linear cycle (#101)
//   GET /api/items/<id>              one item's runs (14 days)
//   GET /api/items/<id>/detail       its issue and PR from GitHub, with its comments and what can be asked of it (#85)
//   GET /api/items/<id>/exploration  an exploration PR's findings and their threads, to review them (#93)
//   GET /api/items/<id>/files        its PR's changed files and review threads, as "Files changed" (#111)
//   GET /api/items/<id>/files/content?path=  one of those files at the PR's head, for the lines around its hunks
//   GET /api/items/<id>/files/mine    the person's own: the files they marked as viewed, and their pending review
//   POST /api/items/<id>/files/actions  a comment, a reply, resolving a thread, marking a file viewed, the review, as the person (dashboard-files-actions.ts)
//   POST /api/items/<id>/exploration/actions  a comment on one of them, as the person (dashboard-exploration-actions.ts)
//   POST /api/items/<id>/exploration/general  a general comment on the PR, as the person
//   POST /api/items/<id>/exploration/approve  an approving review, as the person
//   POST /api/items/<id>/actions     asks for one of those (dashboard-actions.ts)
//   POST /api/repos/<owner>/<repo>/issues  a new issue, as the person, and what to do with it (#100)
//   GET /api/runs/<runId>            one run's transcript
//   GET /api/runs/<runId>/stream     the rest of it as it happens (SSE)
//   GET /api/evidence/<owner>/<repo>/<sha>/<path>  a screenshot ronin published (dashboard-evidence.ts)
//   GET|POST /api/portal-admin[/…]   the request portal's accounts, for admins only (#114, portal-admin.ts)
//   GET /api/pedidos                 the request portal's requests, of the repos it sees (#132, dashboard-portal.ts)
//   GET /api/pedidos/<n>             one of them: its conversation, its activity and its runs
//   GET /api/pedidos/<n>/img/<file>  one of its images (the person's, or a prototype's)
//   GET /api/pedidos/<n>/prototipo/<round>  a prototype's draft diff
//   GET /api/pedidos/<n>/reproduccion/<round>  a reproduction's diff (#137)
//   GET /api/exploraciones           each app a repo explores, with its exploration PR's findings counted and its runs (#155, dashboard-exploraciones.ts)
//   GET /api/exploraciones/<owner>/<repo>/<app>/corridas    the app's exploration runs, with their agents
//   GET /api/exploraciones/<owner>/<repo>/<app>/inventario  the app's functions and their coverage (inventory.yml)
//   POST /api/exploraciones/<owner>/<repo>/<app>/run         explore it now: { maxFunctions, hours, tonight } (Explorar ahora)
//   GET /api/despliegues             each repo with deploy in repos.json: what's merged and not deployed, its last releases and their workflow (#158, admins only)
//   POST /api/despliegues/<owner>/<repo>/plan     what a release would carry: { tag, prs: 'all' | [n…], prerelease? }, with its problems
//   POST /api/despliegues/<owner>/<repo>/publish  publishes it: the same, and { title?, notes?, fingerprint? }
//   GET /api/reuniones               the meetings whose notes were uploaded, of the repos it sees (#62, dashboard-meetings.ts)
//   POST /api/reuniones              uploads one: the notes as a file or pasted
//   GET /api/reuniones/<n>           one of them, with its notes' text
//   GET /api/reuniones/<n>/original  the file as it was uploaded, to download
//   POST /api/reuniones/<n>/reintentar  reads it again, after its reading failed
//   POST /api/reuniones/<n>/aprobar  creates what the person chose of its proposals, as them (dashboard-meetings-approve.ts)
//   POST /api/reuniones/<n>/descartar  sets the rest of it aside
//   GET|POST /api/ajustes[/…]        the person's profile, and for admins the settings and their record (#174, ajustes.ts)

// How far back the sidebar and an item's history look. Run records are kept
// 14 days (scripts/setup-cron.sh).
const SIDEBAR_DAYS = 3;
const HISTORY_DAYS = 14;
const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15_000;

// Which repos the request's session sees (#106, access.ts): set by
// handleDashboard for the whole request, so every read below goes through
// visibleRepos() and listRuns() and never reaches a repo the person can't
// see on GitHub. Outside a request there's no access at all.
const requestAccess = new AsyncLocalStorage<Access>();

function currentAccess(): Access {
  const access = requestAccess.getStore();
  if (!access) throw new Error('tablero: lectura fuera de un pedido con sesión');
  return access;
}

async function visibleRepos() {
  const access = currentAccess();
  return (await loadRepos()).filter((entry) => sees(access, entry.productRepo));
}

function listRuns(days: number) {
  const access = currentAccess();
  return listAllRuns(days).filter((run) => sees(access, run.repo));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

// What a member can do in each repo (#174, team.ts), checked here for every
// change: the page hides what they can't, but the server is what says no.
const PERM_REFUSAL: Record<Perm, string> = {
  notas: 'no tienes permiso para subir notas de reuniones en este repo',
  aprobar: 'no tienes permiso para aprobar lo que propone una reunión en este repo',
  acciones: 'no tienes permiso para las acciones del tablero en este repo (asignar a ronin, comandos, revisar, auto-merge)',
  desplegar: 'no tienes permiso para desplegar este repo',
};
function refused(res: ServerResponse, repo: string, perm: Perm): boolean {
  if (can(currentAccess(), repo, perm)) return false;
  json(res, 403, { error: PERM_REFUSAL[perm] });
  return true;
}

export async function snapshot(login: string): Promise<unknown> {
  const entries = await visibleRepos();
  const repos = entries.map((repo) => repo.productRepo);
  const runs = listRuns(SIDEBAR_DAYS);
  // A repo's GitHub read is stale once one of its runs started or ended after it.
  const changedSince = (repo: string) => Math.max(0, ...runs.filter((run) => run.repo === repo).map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const github = await Promise.all(entries.map((entry) => repoGithub(entry, changedSince(entry.productRepo))));
  const linear = await Promise.all(entries.map((entry, i) => repoLinear(entry, github[i])));
  // Each issue ronin manages, with its Linear issue: identifier, state, project, cycle.
  const items = buildItems(repos, runs, github).map((item) => {
    const issue = item.kind === 'issue' && item.number !== undefined ? linear[repos.indexOf(item.repo)]?.issues[item.number] : undefined;
    return issue ? { ...item, linear: issue } : item;
  });
  const access = currentAccess();
  return {
    me: login,
    // Whether it sees everything, and through which permission it sees each repo.
    access: { admin: access.admin, repos: access.repos },
    // ronin's GitHub login, for the comments the page shows it'll write.
    ronin: config.githubLogin,
    // Whether it can manage the request portal's accounts (#114).
    portalAdmin: access.admin && missingPortalConfig(config.portal).length === 0,
    // The portal's requests still going, for the sidebar, and how many there are in all (#132).
    ...(await portalSummary(runs)),
    // The meetings that wait on someone to review what ronin proposed (#62).
    reunionesPorRevisar: (await visibleMeetings()).filter((m) => m.status === 'review').length,
    repos,
    // The queue and the Claude accounts, only of the repos it sees.
    runner: { slots: { used: slotsInUse(), limit: config.tickConcurrency }, queue: readQueue().filter((job) => !job.repo || repos.includes(job.repo)), tick: readTickInfo() },
    usage: readUsage().filter((u) => entries.some((entry) => accountName(entry.claudeConfigDir ?? '') === u.account)),
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

const prsOf = (entries: Array<{ productRepo: string }>, github: Array<Awaited<ReturnType<typeof repoGithub>>>) => new Map(entries.map((entry, i) => [entry.productRepo, github[i]?.prs ?? []]));

// GET /api/exploraciones: the apps, with the findings, the last run and the next (#155).
async function exploraciones(): Promise<unknown> {
  const entries = await visibleRepos();
  const runs = listRuns(HISTORY_DAYS);
  const github = await Promise.all(entries.map((entry) => repoGithub(entry)));
  const prs = prsOf(entries, github);
  return { apps: await exploracionList(entries, exploracionRows(entries, prs, runs, await liveRuns(entries)), runs, prs) };
}

// GET /api/exploraciones/<owner>/<repo>/<app>/<what>: one app's runs or
// inventory (#155). Null for an app no repo it sees explores.
async function exploracion(repo: string, app: string, what: string): Promise<unknown | null> {
  const entry = (await visibleRepos()).find((e) => e.productRepo === repo);
  if (!entry || !(entry.explore ?? []).includes(app)) return null;
  if (what === 'corridas') return { corridas: await corridasOf(entry, app, listRuns(HISTORY_DAYS)) };
  const pr = (await repoGithub(entry))?.prs.find(isExplorationPr);
  return inventarioOf(entry, app, pr);
}

// POST /api/exploraciones/<owner>/<repo>/<app>/run: explore the app now, as
// whoever is logged in (#155). Anyone who sees the repo can, as with a new issue.
async function postExploreNow(req: IncomingMessage, res: ServerResponse, repo: string, app: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req);
  const entry = (await visibleRepos()).find((e) => e.productRepo === repo);
  if (!entry || !(entry.explore ?? []).includes(app)) {
    json(res, 404, { error: 'ningún repo de ronin explora esa app' });
    return;
  }
  if (refused(res, repo, 'acciones')) return;
  try {
    const launched = await exploreNow(entry, app, session.login, parseExploreNow(body ?? {}));
    log.info(`tablero: ${session.login} lanzó una exploración de ${app} en ${repo}`);
    json(res, 200, launched);
  } catch (error) {
    if (error instanceof ExploreNowError) json(res, error.status, { error: error.message });
    else throw error;
  }
}

// POST /api/despliegues/<owner>/<repo>/(plan|publish) (#158): admins, and
// whoever an admin let deploy that repo (#174).
async function postDespliegue(req: IncomingMessage, res: ServerResponse, repo: string, what: string, session: Session): Promise<void> {
  if (refused(res, repo, 'desplegar')) return;
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const entry = (await visibleRepos()).find((e) => e.productRepo === repo && e.deploy);
  if (!entry) {
    json(res, 404, { error: 'ese repo no se despliega desde ronin (deploy en repos.json)' });
    return;
  }
  try {
    const body = parseRelease((await readJson(req)) ?? {});
    if (what === 'plan') json(res, 200, await planDespliegue(entry, body));
    else {
      const done = await publishDespliegue(entry, body, session.login);
      log.info(`tablero: ${session.login} publicó ${done.tag} en ${repo}`);
      json(res, 200, done);
    }
  } catch (error) {
    if (error instanceof DespliegueError) json(res, error.status, { error: error.message, ...(error.plan ? { plan: error.plan } : {}) });
    else throw error;
  }
}

// The portal's requests of the repos it sees, with whoever asked each.
async function visibleRequests() {
  const access = currentAccess();
  const requests = (await listRequests()).filter((r) => sees(access, r.repo));
  const users = new Map<string, PortalUser>(requests.length ? (await listUsers()).map((u) => [u.id, u]) : []);
  return { requests, users };
}

// The meetings of the repos it sees (#62).
async function visibleMeetings() {
  const access = currentAccess();
  return (await listMeetings()).filter((m) => sees(access, m.repo));
}

async function reuniones(res: ServerResponse, path: string): Promise<void> {
  if (path === '/api/reuniones') {
    json(res, 200, { meetings: (await visibleMeetings()).map(meetingRow).sort((a, b) => b.number - a.number) });
    return;
  }
  const match = /^\/api\/reuniones\/(\d+)(\/original)?$/.exec(path);
  const meeting = match ? await getMeeting(Number(match[1])) : undefined;
  // One of a repo it doesn't see is one that isn't there.
  if (!match || !meeting || !sees(currentAccess(), meeting.repo)) {
    json(res, 404, { error: 'no existe esa reunión' });
    return;
  }
  if (!match[2]) {
    json(res, 200, await meetingDetail(meeting, listRuns(HISTORY_DAYS)));
    return;
  }
  const original = await meetingOriginal(meeting);
  if (original) res.writeHead(200, original.headers).end(original.data);
  else json(res, 404, { error: 'esas notas se pegaron: no hay archivo' });
}

// POST /api/reuniones { repo, title?, at?, link?, text? | file: { name, data } }.
async function postReunion(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req, MAX_UPLOAD_BODY);
  if (!body) {
    json(res, 400, { error: 'el pedido no llegó bien, o el archivo pesa más de 10 MB' });
    return;
  }
  // Before reading the notes: a repo it sees but can't upload to.
  if (typeof body.repo === 'string' && sees(currentAccess(), body.repo) && refused(res, body.repo, 'notas')) return;
  try {
    const meeting = await createMeeting(await parseUpload(body, await visibleRepos(), session.login));
    // ronin reads it right away; if the launch fails, the tick does.
    await launchMeetingWorker(meeting.number).catch((error) => log.error(`reuniones: no se pudo lanzar el worker de R-${meeting.number}`, error));
    json(res, 200, meetingRow((await getMeeting(meeting.number)) ?? meeting));
  } catch (error) {
    if (error instanceof DuplicateMeeting) json(res, 409, { error: error.message, number: error.number });
    else if (error instanceof MeetingUploadError) json(res, 400, { error: error.message });
    else throw error;
  }
}

// POST /api/reuniones/<n>/aprobar { items: [{ id, title?, body?, lead?, project?, cycle? }] }, or /descartar.
async function postDecision(req: IncomingMessage, res: ServerResponse, n: number, what: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req, 512 * 1024);
  const meeting = await getMeeting(n);
  const entry = meeting && (await visibleRepos()).find((e) => e.productRepo === meeting.repo);
  if (!meeting || !entry) {
    json(res, 404, { error: 'no existe esa reunión' });
    return;
  }
  if (refused(res, meeting.repo, 'aprobar')) return;
  try {
    if (what === 'descartar') {
      await discardMeeting(n, session.login);
      json(res, 200, { status: 'discarded' });
      return;
    }
    const outcome = await approveMeeting(entry, n, session, body?.items);
    // The next snapshot lists the new issues.
    forgetGithub(entry.productRepo);
    json(res, 200, outcome);
  } catch (error) {
    if (error instanceof ApproveError) json(res, error.status, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
  }
}

async function portalSummary(runs: ReturnType<typeof listRuns>) {
  const { requests, users } = await visibleRequests();
  const entries = await visibleRepos();
  return {
    pedidos: requests.filter(isOpen).map((r) => requestRow(r, users.get(r.userId), entries, runs)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    pedidosTotal: requests.length,
  };
}

async function pedidos(res: ServerResponse, path: string): Promise<void> {
  if (path === '/api/pedidos') {
    const { requests, users } = await visibleRequests();
    const entries = await visibleRepos();
    const runs = listRuns(HISTORY_DAYS);
    json(res, 200, { requests: requests.map((r) => requestRow(r, users.get(r.userId), entries, runs)).sort((a, b) => b.number - a.number) });
    return;
  }
  const match = /^\/api\/pedidos\/(\d+)(?:\/(img|prototipo|reproduccion)\/([^/]+))?$/.exec(path);
  const request = match ? await getRequest(Number(match[1])) : undefined;
  // One of a repo it doesn't see is one that isn't there.
  if (!match || !request || !sees(currentAccess(), request.repo)) {
    json(res, 404, { error: 'no existe ese pedido' });
    return;
  }
  if (match[2] === 'img') {
    let file = '';
    try {
      file = decodeURIComponent(match[3]);
    } catch {
      // A name that doesn't decode is one the request doesn't have.
    }
    const image = await requestImage(request, file);
    if (image) res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400' }).end(image.data);
    else json(res, 404, { error: 'no existe esa imagen' });
    return;
  }
  if (match[2] === 'prototipo' || match[2] === 'reproduccion') {
    const prototype = match[2] === 'prototipo';
    const patch = await requestPatch(request, Number(match[3]), prototype ? 'prototype' : 'reproduction');
    if (patch === null) json(res, 404, { error: prototype ? 'ese prototipo no dejó diff' : 'esa reproducción no dejó diff' });
    else json(res, 200, { patch });
    return;
  }
  const users = new Map((await listUsers()).map((u) => [u.id, u]));
  json(res, 200, requestDetail(request, users.get(request.userId), await visibleRepos(), listRuns(HISTORY_DAYS)));
}

// Hoy: the runs, and each repo's current Linear cycle, where ronin's issues
// stand by what GitHub says of them.
async function todayWithCycles(): Promise<unknown> {
  const entries = await visibleRepos();
  const cycles = await Promise.all(entries.map(async (entry) => {
    const gh = await repoGithub(entry);
    const linear = await repoLinear(entry, gh);
    return linear ? cycleView(linear, gh) : null;
  }));
  return { ...today(listRuns(WEEK_DAYS)), cycles: cycles.filter(Boolean) };
}

// An issue or PR of a repo in repos.json: what it is, and when one of its
// runs last started or ended. Null for an item that isn't one (a changelog entry).
async function itemRef(id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  if (!match) return null;
  const entry = (await visibleRepos()).find((repo) => repo.productRepo === match[1]);
  if (!entry) return null;
  const gh = await repoGithub(entry);
  const keys = itemRunKeys(id, gh);
  const runs = listRuns(HISTORY_DAYS).filter((run) => keys.includes(itemKey(run)));
  const changedSince = Math.max(0, ...runs.map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const runKind = runs[0] ? (runs[0].issueNumber !== undefined ? 'issue' : 'pr') : undefined;
  // Neither listed nor run on lately (opened by its number): GitHub says what it is.
  const number = Number(match[2]);
  const ref = resolveItem(number, gh, runKind) ?? resolveItem(number, undefined, (await withActiveRepo(entry, () => itemKindOf(number))) ?? undefined);
  return ref && { entry, ref, gh, changedSince };
}

// The item, with what GitHub has on it.
async function itemContext(id: string) {
  const ctx = await itemRef(id);
  return ctx && { ...ctx, detail: await itemDetail(ctx.entry, ctx.ref, ctx.changedSince) };
}

// The files of the item's PR: a PR's own, an issue's moving PR's. Null for
// an item with no PR.
async function filesContext(id: string) {
  const ctx = await itemRef(id);
  if (!ctx) return null;
  const prNumber = ctx.ref.kind === 'pr' ? ctx.ref.number : ctx.ref.pr;
  if (prNumber === undefined) return null;
  return { entry: ctx.entry, prNumber, files: await prFiles(ctx.entry, prNumber, ctx.changedSince) };
}

async function detail(id: string, login: string): Promise<unknown | null> {
  const ctx = await itemContext(id);
  if (!ctx) return null;
  // `ronin`: its login, so the page can tell its comments apart. `exploration`:
  // an exploration PR, whose page has its findings to review (#93).
  const pr = ctx.ref.kind === 'pr' ? ctx.gh?.prs.find((p) => p.number === ctx.ref.number) : undefined;
  return { ref: ctx.ref, ronin: config.githubLogin, ...ctx.detail, exploration: Boolean(pr && isExplorationPr(pr)), actions: listActions(ctx.ref, ctx.gh, ctx.detail, login), pedido: await pedidoOf(ctx.entry.productRepo, ctx.ref) };
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
async function explorationContext(id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  const entry = match && (await visibleRepos()).find((repo) => repo.productRepo === match[1]);
  if (!match || !entry) return null;
  const gh = await repoGithub(entry);
  const pr = gh?.prs.find((p) => p.number === Number(match[2]));
  if (!pr || !isExplorationPr(pr)) return null;
  const keys = itemRunKeys(id, gh);
  const changedSince = Math.max(0, ...listRuns(HISTORY_DAYS).filter((run) => keys.includes(itemKey(run))).map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  return { entry, pr, review: await explorationReview(entry, pr, changedSince) };
}

async function exploration(id: string): Promise<unknown | null> {
  const ctx = await explorationContext(id);
  return ctx && { ronin: config.githubLogin, ...ctx.review };
}

// What GitHub refused when writing as the person: a token no longer good
// asks to log in again (401, as the page reads it).
function githubRefusal(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof GithubUserError)) return false;
  json(res, error.relogin ? 401 : 502, { error: error.message });
  return true;
}

const MAX_BODY = 16 * 1024;

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// POST /api/items/<id>/actions { action, text? }. Only JSON: a form from
// another site can't send it, on top of tailnet.ts's Origin check.
async function postAction(req: IncomingMessage, res: ServerResponse, id: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req);
  if (!body || typeof body.action !== 'string') {
    json(res, 400, { error: 'falta la acción' });
    return;
  }
  const ctx = await itemContext(id);
  if (!ctx) {
    json(res, 404, { error: 'ese ítem no es un issue ni un PR de un repo de ronin' });
    return;
  }
  if (refused(res, ctx.entry.productRepo, 'acciones')) return;
  try {
    const done = await runAction(ctx.entry, ctx.ref, ctx.gh, ctx.detail, session, body.action, body.text);
    // The next read shows the comment and whatever the action changed.
    forgetDetails(ctx.entry.productRepo);
    forgetFiles(ctx.entry.productRepo);
    json(res, 200, done);
  } catch (error) {
    if (error instanceof ActionError) json(res, 409, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
  }
}

// POST /api/repos/<owner>/<repo>/issues: { title, body, after, app?, instruction? }.
async function postNewIssue(req: IncomingMessage, res: ServerResponse, repo: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req);
  const entry = (await visibleRepos()).find((r) => r.productRepo === repo);
  if (!entry) {
    json(res, 404, { error: 'ese repo no está en repos.json' });
    return;
  }
  if (refused(res, repo, 'acciones')) return;
  try {
    const linear = await repoLinear(entry, await repoGithub(entry));
    const issue = parseNewIssue(body ?? {}, await repoApps(entry), linear?.planning);
    const created = await createFromDashboard(entry, session, issue, config.githubLogin);
    // The next snapshot lists it.
    forgetGithub(entry.productRepo);
    json(res, 200, created);
  } catch (error) {
    if (error instanceof NewIssueError) json(res, 400, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
  }
}

// The request portal's accounts (#114): only for the dashboard's admins,
// over every repo of the portal.
async function portalAdmin(req: IncomingMessage, res: ServerResponse, path: string, session: Session): Promise<void> {
  if (!currentAccess().admin) {
    json(res, 403, { error: 'solo los administradores del tablero manejan las cuentas del portal' });
    return;
  }
  const ctx: PortalAdminContext = {
    url: config.portal.url,
    enabled: missingPortalConfig(config.portal).length === 0,
    dailyLimit: config.portal.dailyLimit,
    entries: await loadRepos(),
    admin: session.login,
  };
  if (req.method === 'GET' && path === '/api/portal-admin') {
    json(res, 200, await portalAdminView(ctx));
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'método no permitido' });
    return;
  }
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  try {
    json(res, 200, await runPortalAdmin(ctx, path, (await readJson(req)) ?? {}));
  } catch (error) {
    if (error instanceof PortalAdminError) json(res, error.status, { error: error.message });
    else throw error;
  }
}

// Ajustes (#174): the profile is everyone's own; the settings and the
// record, admins only.
async function ajustes(req: IncomingMessage, res: ServerResponse, path: string, session: Session): Promise<void> {
  const admin = currentAccess().admin;
  if (req.method === 'GET' && path === '/api/ajustes') {
    json(res, 200, await ajustesView(session.login, admin, await visibleRepos()));
    return;
  }
  if (req.method === 'GET' && path === '/api/ajustes/registro') {
    if (!admin) json(res, 403, { error: 'solo los administradores ven el registro' });
    else json(res, 200, { registro: await readRegistro() });
    return;
  }
  const repoEdit = /^\/api\/ajustes\/repos(?:\/([\w.-]+\/[\w.-]+))?$/.exec(path);
  if (repoEdit) {
    if (!admin) json(res, 403, { error: 'solo los administradores cambian los repos' });
    else if (req.method === 'GET' && !repoEdit[1]) json(res, 200, await reposView(await loadRepos()));
    else if (req.method !== 'POST' || !repoEdit[1]) json(res, 405, { error: 'método no permitido' });
    else if (!(req.headers['content-type'] ?? '').startsWith('application/json')) json(res, 415, { error: 'se espera JSON' });
    else {
      try {
        json(res, 200, await editRepo(session.login, repoEdit[1], (await readJson(req)) ?? {}, await loadRepos()));
        forgetGithub(repoEdit[1]);
      } catch (error) {
        if (error instanceof AjustesError) json(res, error.status, { error: error.message });
        else throw error;
      }
    }
    return;
  }
  const usuario = /^\/api\/ajustes\/usuarios(?:\/([a-z\d-]+))?(\/quitar)?$/.exec(path);
  if (usuario || path === '/api/ajustes/equipo') {
    if (!admin) {
      json(res, 403, { error: 'solo los administradores manejan los usuarios' });
      return;
    }
    if (req.method === 'GET' && usuario && !usuario[2]) {
      const view = usuario[1] ? await usuarioView(usuario[1], await loadRepos()) : await usuariosView(await loadRepos());
      if (view) json(res, 200, view);
      else json(res, 404, { error: 'esa persona no está en la lista' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'método no permitido' });
      return;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      json(res, 415, { error: 'se espera JSON' });
      return;
    }
    const body = (await readJson(req)) ?? {};
    try {
      if (path === '/api/ajustes/equipo') json(res, 200, await updateEquipo(session.login, body));
      else if (!usuario![1]) json(res, 200, await addUsuario(session.login, body));
      else if (usuario![2]) json(res, 200, await removeUsuario(session.login, usuario![1]));
      else json(res, 200, await updateUsuario(session.login, usuario![1], body, await loadRepos()));
    } catch (error) {
      if (error instanceof AjustesError) json(res, error.status, { error: error.message });
      else throw error;
    }
    return;
  }
  if (req.method !== 'POST' || !['/api/ajustes/perfil', '/api/ajustes/valores', '/api/ajustes/notificaciones'].includes(path)) {
    json(res, 404, { error: 'no existe' });
    return;
  }
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = (await readJson(req)) ?? {};
  try {
    if (path === '/api/ajustes/perfil') json(res, 200, await saveProfile(session.login, body, await linearTeams(await visibleRepos())));
    else if (path === '/api/ajustes/notificaciones') json(res, 200, await saveNotificacion(session.login, body, await visibleRepos()));
    else if (!admin) json(res, 403, { error: 'solo los administradores cambian los ajustes' });
    else json(res, 200, await setValue(session.login, body));
  } catch (error) {
    if (error instanceof AjustesError) json(res, error.status, { error: error.message });
    else throw error;
  }
}

// POST /api/items/<id>/exploration/<what>: actions { action, ficha, text,
// redo? } on a finding, general { text }, approve { text? }.
async function postExploration(req: IncomingMessage, res: ServerResponse, id: string, what: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req);
  if (!body) {
    json(res, 400, { error: 'falta el pedido' });
    return;
  }
  const ctx = await explorationContext(id);
  if (!ctx) {
    json(res, 404, { error: 'ese ítem no es un PR de exploración abierto de un repo de ronin' });
    return;
  }
  if (refused(res, ctx.entry.productRepo, 'acciones')) return;
  try {
    const done = what === 'approve'
      ? await runApprove(ctx.entry, ctx.pr, ctx.review, session, body)
      : what === 'general'
        ? await runGeneralComment(ctx.entry, ctx.pr, session, body)
        : await runFichaAction(ctx.entry, ctx.pr, ctx.review, session, body);
    forgetExploration(ctx.entry.productRepo, ctx.pr.number);
    forgetDetails(ctx.entry.productRepo);
    forgetFiles(ctx.entry.productRepo);
    json(res, 200, done);
  } catch (error) {
    if (error instanceof FichaActionError) json(res, 409, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
  }
}

// POST /api/items/<id>/files/actions { action: comment | reply | resolve | viewed, … }.
async function postFilesAction(req: IncomingMessage, res: ServerResponse, id: string, session: Session): Promise<void> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    json(res, 415, { error: 'se espera JSON' });
    return;
  }
  const body = await readJson(req);
  if (!body) {
    json(res, 400, { error: 'falta el pedido' });
    return;
  }
  const ctx = await filesContext(id);
  if (!ctx) {
    json(res, 404, { error: 'ese ítem no tiene un PR de un repo de ronin' });
    return;
  }
  // Marking a file as looked at is only the person's own.
  if (body.action !== 'viewed' && refused(res, ctx.entry.productRepo, 'acciones')) return;
  try {
    const done = await runFilesAction(ctx.entry, ctx.prNumber, ctx.files, session, body, config.githubLogin);
    // A viewed mark and a pending review are only the person's; the rest changes what everyone reads.
    if (!(body.action === 'viewed' || body.review || String(body.action).startsWith('pending-'))) {
      forgetFiles(ctx.entry.productRepo);
      forgetDetails(ctx.entry.productRepo);
    }
    // An approval or a request for changes is on the PR's chips: the next snapshot reads it.
    if (body.action === 'submit') forgetGithub(ctx.entry.productRepo);
    json(res, 200, done);
  } catch (error) {
    if (error instanceof FilesActionError) json(res, 400, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
  }
}

function streamRun(req: IncomingMessage, res: ServerResponse, path: string, from: number): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  let sent = from;
  let lastWrite = Date.now();
  const finish = () => {
    clearInterval(timer);
    res.end();
  };
  const timer = setInterval(() => {
    let lines;
    try {
      lines = readRunLines(path);
    } catch {
      finish();
      return;
    }
    for (const line of lines.slice(sent)) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
      lastWrite = Date.now();
    }
    sent = Math.max(sent, lines.length);
    const summary = summarizeRun(lines);
    if (!summary || summary.state !== 'running') {
      res.write(`event: end\ndata: ${JSON.stringify(summary?.state ?? 'error')}\n\n`);
      finish();
    } else if (Date.now() - lastWrite > STREAM_HEARTBEAT_MS) {
      res.write(': sigue\n\n');
      lastWrite = Date.now();
    }
  }, STREAM_POLL_MS);
  req.on('close', () => clearInterval(timer));
}

// Segments arrive one by one URI-encoded, as evidenceUrl writes them.
async function serveEvidence(res: ServerResponse, raw: string): Promise<void> {
  let parts: string[];
  try {
    parts = raw.split('/').map(decodeURIComponent);
  } catch {
    parts = [];
  }
  const [owner, name, sha, ...segments] = parts;
  const entry = (await visibleRepos()).find((repo) => repo.productRepo === `${owner}/${name}`);
  const image = entry && (await readEvidence(entry, sha ?? '', segments));
  if (!image) {
    json(res, 404, { error: 'no existe esa imagen' });
    return;
  }
  // A sha never changes what it points to.
  res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=31536000, immutable' }).end(image.data);
}

// One of the PR's files at its head: only a file the PR changes, so the
// endpoint can't read just anything from the repo.
async function serveFileContent(req: IncomingMessage, res: ServerResponse, ctx: NonNullable<Awaited<ReturnType<typeof filesContext>>>): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? '';
  const file = ctx.files.files.find((f) => f.path === path);
  if (!file || file.status === 'removed' || !ctx.files.headSha) {
    json(res, 404, { error: 'el PR no cambia ese archivo' });
    return;
  }
  try {
    const text = await fileContent(ctx.entry, ctx.files.headSha, path);
    if (text === null) json(res, 413, { error: 'el archivo es demasiado grande para mostrarlo entero' });
    else json(res, 200, { sha: ctx.files.headSha, text });
  } catch (error) {
    json(res, 502, { error: `GitHub no respondió: ${(error as Error).message.split('\n')[0]}` });
  }
}

// /api/snapshot, /api/today, /api/items/*, /api/runs/*, /api/evidence/*. Returns false for a
// path it doesn't own.
export async function handleDashboard(req: IncomingMessage, res: ServerResponse, path: string, session: Session, access: Access): Promise<boolean> {
  return requestAccess.run(access, () => route(req, res, path, session));
}

async function route(req: IncomingMessage, res: ServerResponse, path: string, session: Session): Promise<boolean> {
  const login = session.login;
  if (path === '/api/portal-admin' || path.startsWith('/api/portal-admin/')) {
    await portalAdmin(req, res, path, session);
    return true;
  }
  if (path === '/api/ajustes' || path.startsWith('/api/ajustes/')) {
    await ajustes(req, res, path, session);
    return true;
  }
  if (req.method === 'GET' && (path === '/api/pedidos' || path.startsWith('/api/pedidos/'))) {
    await pedidos(res, path);
    return true;
  }
  if (path === '/api/reuniones' && req.method === 'POST') {
    await postReunion(req, res, session);
    return true;
  }
  const decide = /^\/api\/reuniones\/(\d+)\/(aprobar|descartar)$/.exec(path);
  if (decide && req.method === 'POST') {
    await postDecision(req, res, Number(decide[1]), decide[2], session);
    return true;
  }
  const retry = /^\/api\/reuniones\/(\d+)\/reintentar$/.exec(path);
  if (retry && req.method === 'POST') {
    const meeting = await getMeeting(Number(retry[1]));
    if (!meeting || !sees(currentAccess(), meeting.repo)) json(res, 404, { error: 'no existe esa reunión' });
    else if (refused(res, meeting.repo, 'notas')) return true;
    else if (await retryMeeting(meeting.number, login)) {
      await launchMeetingWorker(meeting.number).catch((error) => log.error(`reuniones: no se pudo lanzar el worker de R-${meeting.number}`, error));
      json(res, 200, { ok: true });
    }
    else json(res, 409, { error: 'esa reunión no falló: no hay nada que reintentar' });
    return true;
  }
  if (req.method === 'GET' && (path === '/api/reuniones' || path.startsWith('/api/reuniones/'))) {
    await reuniones(res, path);
    return true;
  }
  const explorationPost = /^\/api\/items\/(.+)\/exploration\/(actions|general|approve)$/.exec(path);
  if (explorationPost && req.method === 'POST') {
    await postExploration(req, res, decodeURIComponent(explorationPost[1]), explorationPost[2], session);
    return true;
  }
  const filesPost = /^\/api\/items\/(.+)\/files\/actions$/.exec(path);
  if (filesPost && req.method === 'POST') {
    await postFilesAction(req, res, decodeURIComponent(filesPost[1]), session);
    return true;
  }
  const deployPost = /^\/api\/despliegues\/([\w.-]+\/[\w.-]+)\/(plan|publish)$/.exec(path);
  if (deployPost && req.method === 'POST') {
    await postDespliegue(req, res, deployPost[1], deployPost[2], session);
    return true;
  }
  const exploreRun = /^\/api\/exploraciones\/([\w.-]+\/[\w.-]+)\/([\w.-]+)\/run$/.exec(path);
  if (exploreRun && req.method === 'POST') {
    await postExploreNow(req, res, exploreRun[1], exploreRun[2], session);
    return true;
  }
  const newIssue = /^\/api\/repos\/([\w.-]+\/[\w.-]+)\/issues$/.exec(path);
  if (newIssue && req.method === 'POST') {
    await postNewIssue(req, res, newIssue[1], session);
    return true;
  }
  const action = /^\/api\/items\/(.+)\/actions$/.exec(path);
  if (action && req.method === 'POST') {
    await postAction(req, res, decodeURIComponent(action[1]), session);
    return true;
  }
  if (req.method !== 'GET') return false;

  if (path === '/api/snapshot') {
    await touchSeen(login);
    json(res, 200, await snapshot(login));
    return true;
  }

  if (path === '/api/despliegues') {
    const mine = (await visibleRepos()).filter((entry) => can(currentAccess(), entry.productRepo, 'desplegar'));
    if (!mine.length) json(res, 403, { error: 'no tienes permiso para desplegar ningún repo' });
    else json(res, 200, { repos: await despliegues(mine) });
    return true;
  }

  if (path === '/api/exploraciones') {
    json(res, 200, await exploraciones());
    return true;
  }
  const xpl = /^\/api\/exploraciones\/([\w.-]+\/[\w.-]+)\/([\w.-]+)\/(corridas|inventario)$/.exec(path);
  if (xpl) {
    const body = await exploracion(xpl[1], xpl[2], xpl[3]);
    if (body) json(res, 200, body);
    else json(res, 404, { error: 'ningún repo de ronin explora esa app' });
    return true;
  }

  if (path === '/api/today') {
    json(res, 200, await todayWithCycles());
    return true;
  }

  const itemPage = /^\/api\/items\/(.+)\/detail$/.exec(path);
  if (itemPage) {
    const body = await detail(decodeURIComponent(itemPage[1]), login);
    if (body) json(res, 200, body);
    else json(res, 404, { error: 'ese ítem no es un issue ni un PR de un repo de ronin' });
    return true;
  }

  const filesPage = /^\/api\/items\/(.+)\/files(?:\/(content|mine))?$/.exec(path);
  if (filesPage) {
    const ctx = await filesContext(decodeURIComponent(filesPage[1]));
    if (!ctx) json(res, 404, { error: 'ese ítem no tiene un PR de un repo de ronin' });
    else if (!filesPage[2]) json(res, 200, { pr: ctx.prNumber, ...ctx.files });
    else if (filesPage[2] === 'content') await serveFileContent(req, res, ctx);
    else {
      // Each person's own: read with their token, never cached.
      try {
        const [viewed, review] = await Promise.all([viewedFiles(session.token, ctx.entry.productRepo, ctx.prNumber), pendingReview(session.token, ctx.entry.productRepo, ctx.prNumber)]);
        json(res, 200, { viewed, review });
      } catch (error) {
        if (!githubRefusal(res, error)) throw error;
      }
    }
    return true;
  }

  const explorationPage = /^\/api\/items\/(.+)\/exploration$/.exec(path);
  if (explorationPage) {
    const body = await exploration(decodeURIComponent(explorationPage[1]));
    if (body) json(res, 200, body);
    else json(res, 404, { error: 'ese ítem no es un PR de exploración abierto de un repo de ronin' });
    return true;
  }

  const item = /^\/api\/items\/(.+)$/.exec(path);
  if (item) {
    const id = decodeURIComponent(item[1]);
    // An issue ronin manages can have no runs in that window: an empty list.
    // Its slices' PR runs are its own too (itemRunKeys), as in the sidebar.
    const entry = (await visibleRepos()).find((repo) => id.startsWith(`${repo.productRepo}#`));
    if (!entry && !listRuns(HISTORY_DAYS).some((run) => itemKey(run) === id)) {
      json(res, 404, { error: 'no existe ese ítem' });
      return true;
    }
    const keys = itemRunKeys(id, entry ? await repoGithub(entry) : undefined);
    json(res, 200, { id, runs: listRuns(HISTORY_DAYS).filter((run) => keys.includes(itemKey(run))) });
    return true;
  }

  if (path.startsWith('/api/evidence/')) {
    await serveEvidence(res, path.slice('/api/evidence/'.length));
    return true;
  }

  const run = /^\/api\/runs\/([^/]+)(\/stream)?$/.exec(path);
  if (run) {
    const file = runPath(run[1]);
    // A run of a repo the session doesn't see is as good as missing.
    const summary = file && existsSync(file) ? summarizeRun(readRunLines(file)) : null;
    if (!file || !summary || !sees(currentAccess(), summary.repo)) {
      json(res, 404, { error: 'no existe esa corrida' });
      return true;
    }
    if (run[2]) {
      const from = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('from') ?? 0);
      streamRun(req, res, file, Number.isInteger(from) && from >= 0 ? from : 0);
    } else {
      const lines = readRunLines(file);
      json(res, 200, { summary, lines });
    }
    return true;
  }

  return false;
}
