import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { config } from '../../core/config.js';
import { loadRepos } from '../../core/repos.js';
import { itemKindOf } from '../../core/github.js';
import { withActiveRepo } from '../../core/repo-context.js';
import { itemKey, listRuns, readQueue, readRunLines, readTickInfo, readUsage, runPath, slotsInUse, summarizeRun } from './dashboard-data.js';
import { forgetGithub, repoGithub } from './dashboard-github.js';
import { createFromDashboard, NewIssueError, parseNewIssue, repoApps } from './dashboard-new-issue.js';
import { cycleView, repoLinear } from './dashboard-linear.js';
import { buildItems, itemRunKeys } from './dashboard-items.js';
import { forgetDetails, itemDetail, resolveItem } from './dashboard-detail.js';
import { ActionError, listActions, runAction } from './dashboard-actions.js';
import { today, WEEK_DAYS } from './dashboard-today.js';
import { readEvidence } from './dashboard-evidence.js';
import { explorationReview, forgetExploration, isExplorationPr } from './dashboard-exploration.js';
import { FichaActionError, runApprove, runFichaAction, runGeneralComment } from './dashboard-exploration-actions.js';
import { GithubUserError } from './github-as-user.js';
import type { Session } from './auth.js';

// The dashboard's data (#65), all behind the session (tailnet.ts checks it
// before any of this runs):
//   GET /api/snapshot                the sidebar and the status bar
//   GET /api/today                   the last 12 hours' runs, the day's totals and the week's, and each repo's Linear cycle (#101)
//   GET /api/items/<id>              one item's runs (14 days)
//   GET /api/items/<id>/detail       its issue and PR from GitHub, with its comments and what can be asked of it (#85)
//   GET /api/items/<id>/exploration  an exploration PR's findings and their threads, to review them (#93)
//   POST /api/items/<id>/exploration/actions  a comment on one of them, as the person (dashboard-exploration-actions.ts)
//   POST /api/items/<id>/exploration/general  a general comment on the PR, as the person
//   POST /api/items/<id>/exploration/approve  an approving review, as the person
//   POST /api/items/<id>/actions     asks for one of those (dashboard-actions.ts)
//   POST /api/repos/<owner>/<repo>/issues  a new issue, as the person, and what to do with it (#100)
//   GET /api/runs/<runId>            one run's transcript
//   GET /api/runs/<runId>/stream     the rest of it as it happens (SSE)
//   GET /api/evidence/<owner>/<repo>/<sha>/<path>  a screenshot ronin published (dashboard-evidence.ts)

// How far back the sidebar and an item's history look. Run records are kept
// 14 days (scripts/setup-cron.sh).
const SIDEBAR_DAYS = 3;
const HISTORY_DAYS = 14;
const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

export async function snapshot(login: string): Promise<unknown> {
  const entries = await loadRepos();
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
  return {
    me: login,
    // ronin's GitHub login, for the comments the page shows it'll write.
    ronin: config.githubLogin,
    repos,
    runner: { slots: { used: slotsInUse(), limit: config.tickConcurrency }, queue: readQueue(), tick: readTickInfo() },
    usage: readUsage(),
    items,
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
      ...(l.error ? { error: l.error } : {}),
    }] : [])),
  };
}

// Hoy: the runs, and each repo's current Linear cycle, where ronin's issues
// stand by what GitHub says of them.
async function todayWithCycles(): Promise<unknown> {
  const entries = await loadRepos();
  const cycles = await Promise.all(entries.map(async (entry) => {
    const gh = await repoGithub(entry);
    const linear = await repoLinear(entry, gh);
    return linear ? cycleView(linear, gh) : null;
  }));
  return { ...today(listRuns(WEEK_DAYS)), cycles: cycles.filter(Boolean) };
}

// An issue or PR of a repo in repos.json: what it is and what GitHub has on
// it. Null for an item that isn't one (a changelog entry).
async function itemContext(id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  if (!match) return null;
  const entry = (await loadRepos()).find((repo) => repo.productRepo === match[1]);
  if (!entry) return null;
  const gh = await repoGithub(entry);
  const keys = itemRunKeys(id, gh);
  const runs = listRuns(HISTORY_DAYS).filter((run) => keys.includes(itemKey(run)));
  const changedSince = Math.max(0, ...runs.map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const runKind = runs[0] ? (runs[0].issueNumber !== undefined ? 'issue' : 'pr') : undefined;
  // Neither listed nor run on lately (opened by its number): GitHub says what it is.
  const number = Number(match[2]);
  const ref = resolveItem(number, gh, runKind) ?? resolveItem(number, undefined, (await withActiveRepo(entry, () => itemKindOf(number))) ?? undefined);
  return ref && { entry, ref, gh, detail: await itemDetail(entry, ref, changedSince) };
}

async function detail(id: string, login: string): Promise<unknown | null> {
  const ctx = await itemContext(id);
  if (!ctx) return null;
  // `ronin`: its login, so the page can tell its comments apart. `exploration`:
  // an exploration PR, whose page has its findings to review (#93).
  const pr = ctx.ref.kind === 'pr' ? ctx.gh?.prs.find((p) => p.number === ctx.ref.number) : undefined;
  return { ref: ctx.ref, ronin: config.githubLogin, ...ctx.detail, exploration: Boolean(pr && isExplorationPr(pr)), actions: listActions(ctx.ref, ctx.gh, ctx.detail, login) };
}

// An open exploration PR of a repo in repos.json, with its findings. Null
// for anything else.
async function explorationContext(id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  const entry = match && (await loadRepos()).find((repo) => repo.productRepo === match[1]);
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
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
  try {
    const done = await runAction(ctx.entry, ctx.ref, ctx.gh, ctx.detail, session, body.action, body.text);
    // The next read shows the comment and whatever the action changed.
    forgetDetails(ctx.entry.productRepo);
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
  const entry = (await loadRepos()).find((r) => r.productRepo === repo);
  if (!entry) {
    json(res, 404, { error: 'ese repo no está en repos.json' });
    return;
  }
  try {
    const issue = parseNewIssue(body ?? {}, await repoApps(entry));
    const created = await createFromDashboard(entry, session, issue, config.githubLogin);
    // The next snapshot lists it.
    forgetGithub(entry.productRepo);
    json(res, 200, created);
  } catch (error) {
    if (error instanceof NewIssueError) json(res, 400, { error: error.message });
    else if (!githubRefusal(res, error)) throw error;
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
  try {
    const done = what === 'approve'
      ? await runApprove(ctx.entry, ctx.pr, ctx.review, session, body)
      : what === 'general'
        ? await runGeneralComment(ctx.entry, ctx.pr, session, body)
        : await runFichaAction(ctx.entry, ctx.pr, ctx.review, session, body);
    forgetExploration(ctx.entry.productRepo, ctx.pr.number);
    forgetDetails(ctx.entry.productRepo);
    json(res, 200, done);
  } catch (error) {
    if (error instanceof FichaActionError) json(res, 409, { error: error.message });
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
  const entry = (await loadRepos()).find((repo) => repo.productRepo === `${owner}/${name}`);
  const image = entry && (await readEvidence(entry, sha ?? '', segments));
  if (!image) {
    json(res, 404, { error: 'no existe esa imagen' });
    return;
  }
  // A sha never changes what it points to.
  res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=31536000, immutable' }).end(image.data);
}

// /api/snapshot, /api/today, /api/items/*, /api/runs/*, /api/evidence/*. Returns false for a
// path it doesn't own.
export async function handleDashboard(req: IncomingMessage, res: ServerResponse, path: string, session: Session): Promise<boolean> {
  const login = session.login;
  const explorationPost = /^\/api\/items\/(.+)\/exploration\/(actions|general|approve)$/.exec(path);
  if (explorationPost && req.method === 'POST') {
    await postExploration(req, res, decodeURIComponent(explorationPost[1]), explorationPost[2], session);
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
    json(res, 200, await snapshot(login));
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
    const entry = (await loadRepos()).find((repo) => id.startsWith(`${repo.productRepo}#`));
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
    if (!file || !existsSync(file)) {
      json(res, 404, { error: 'no existe esa corrida' });
      return true;
    }
    if (run[2]) {
      const from = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('from') ?? 0);
      streamRun(req, res, file, Number.isInteger(from) && from >= 0 ? from : 0);
    } else {
      const lines = readRunLines(file);
      json(res, 200, { summary: summarizeRun(lines), lines });
    }
    return true;
  }

  return false;
}
