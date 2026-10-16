import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { config } from '../../core/config.js';
import { loadRepos } from '../../core/repos.js';
import { itemKey, listRuns, readQueue, readRunLines, readTickInfo, readUsage, runPath, slotsInUse, summarizeRun } from './dashboard-data.js';
import { repoGithub } from './dashboard-github.js';
import { buildItems } from './dashboard-items.js';
import { forgetDetails, itemDetail, resolveItem } from './dashboard-detail.js';
import { ActionError, listActions, runAction } from './dashboard-actions.js';
import { today } from './dashboard-today.js';

// The dashboard's data (#65), all behind the session (tailnet.ts checks it
// before any of this runs):
//   GET /api/snapshot                the sidebar and the status bar
//   GET /api/today                   the last 12 hours' runs and the day's totals
//   GET /api/items/<id>              one item's runs (14 days)
//   GET /api/items/<id>/detail       its issue and PR from GitHub, with its comments and what can be asked of it (#85)
//   POST /api/items/<id>/actions     asks for one of those (dashboard-actions.ts)
//   GET /api/runs/<runId>            one run's transcript
//   GET /api/runs/<runId>/stream     the rest of it as it happens (SSE)

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
  return {
    me: login,
    repos,
    runner: { slots: { used: slotsInUse(), limit: config.tickConcurrency }, queue: readQueue(), tick: readTickInfo() },
    usage: readUsage(),
    items: buildItems(repos, runs, github),
    previews: github.flatMap((gh) => (gh ? gh.previews.map((p) => ({ ...p, repo: gh.repo })) : [])),
    github: github.map((gh, i) => ({ repo: repos[i], fetchedAt: gh?.fetchedAt ?? null, ...(gh?.error ? { error: gh.error } : {}) })),
  };
}

// An issue or PR of a repo in repos.json: what it is and what GitHub has on
// it. Null for an item that isn't one (a changelog entry).
async function itemContext(id: string) {
  const match = /^(.+)#(\d+)$/.exec(id);
  if (!match) return null;
  const entry = (await loadRepos()).find((repo) => repo.productRepo === match[1]);
  if (!entry) return null;
  const runs = listRuns(HISTORY_DAYS).filter((run) => itemKey(run) === id);
  const changedSince = Math.max(0, ...runs.map((run) => Date.parse(run.endedAt ?? run.startedAt)));
  const runKind = runs[0] ? (runs[0].issueNumber !== undefined ? 'issue' : 'pr') : undefined;
  const gh = await repoGithub(entry);
  const ref = resolveItem(Number(match[2]), gh, runKind);
  return ref && { entry, ref, gh, detail: await itemDetail(entry, ref, changedSince) };
}

async function detail(id: string, login: string): Promise<unknown | null> {
  const ctx = await itemContext(id);
  if (!ctx) return null;
  // `ronin`: its login, so the page can tell its comments apart.
  return { ref: ctx.ref, ronin: config.githubLogin, ...ctx.detail, actions: listActions(ctx.ref, ctx.gh, ctx.detail, login) };
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
async function postAction(req: IncomingMessage, res: ServerResponse, id: string, login: string): Promise<void> {
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
    const done = await runAction(ctx.entry, ctx.ref, ctx.gh, ctx.detail, login, body.action, body.text);
    // The next read shows ronin's comment and whatever the action changed.
    forgetDetails(ctx.entry.productRepo);
    json(res, 200, done);
  } catch (error) {
    if (error instanceof ActionError) json(res, 409, { error: error.message });
    else throw error;
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

// /api/snapshot, /api/today, /api/items/*, /api/runs/*. Returns false for a
// path it doesn't own.
export async function handleDashboard(req: IncomingMessage, res: ServerResponse, path: string, login: string): Promise<boolean> {
  const action = /^\/api\/items\/(.+)\/actions$/.exec(path);
  if (action && req.method === 'POST') {
    await postAction(req, res, decodeURIComponent(action[1]), login);
    return true;
  }
  if (req.method !== 'GET') return false;

  if (path === '/api/snapshot') {
    json(res, 200, await snapshot(login));
    return true;
  }

  if (path === '/api/today') {
    json(res, 200, today(listRuns(2)));
    return true;
  }

  const itemPage = /^\/api\/items\/(.+)\/detail$/.exec(path);
  if (itemPage) {
    const body = await detail(decodeURIComponent(itemPage[1]), login);
    if (body) json(res, 200, body);
    else json(res, 404, { error: 'ese ítem no es un issue ni un PR de un repo de ronin' });
    return true;
  }

  const item = /^\/api\/items\/(.+)$/.exec(path);
  if (item) {
    const id = decodeURIComponent(item[1]);
    // An issue ronin manages can have no runs in that window: an empty list.
    json(res, 200, { id, runs: listRuns(HISTORY_DAYS).filter((run) => itemKey(run) === id) });
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
