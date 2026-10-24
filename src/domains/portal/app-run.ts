import { basename, join, resolve } from 'node:path';
import { runAgentTask, type AgentTask } from '@platform/agents/agent-task.js';
import type { PrototypeBrowser, RunningApp } from './prompts.js';
import { appDown, appUp, removeAppCheckout } from '../product-app/index.js';
import { appStack } from '../product-app/services.js';
import type { RunApp } from '@platform/actions/executors.js';
import { asAgent, prepareAgentUser, repoAgentUser, type AgentUser } from '@platform/agents/agent-user.js';
import { loginAllUsers, renderHtmlToPng } from '../product-app/index.js';
import { loadAppDefinition, type AppDefinition } from '../product-app/index.js';
import { config } from '@platform/config/config.js';
import { insideDir } from '../explorations/index.js';
import { mcpServer, originsOf } from '../explorations/index.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { agentCloneAt } from '@platform/git/worktree.js';
import { worktreeLock } from '@platform/workers/worktree-lock.js';
import { host } from '@platform/host/host.js';
import { requestImagePath, type PortalRequest } from './requests.js';
import { parseTeamNotes, type TeamNotes } from './team-notes.js';
import { parseLearned, type Learned } from '../knowledge/knowledge.js';


// A run of an agent on the app, brought up from the base branch in a
// checkout of its own with one logged-in browser per role and viewport: a
// portal request's prototype (prototype.ts) or its reproduction
// (reproduce.ts). Nothing is pushed: the checkout is thrown away once the
// caller has what the agent left. See docs/DESIGN.md §11.11.
//
// In the image (#257), the checkout is a clone of the agent's user: the app
// runs as that user, the agent runs sealed, as it — writing only in its
// checkout and its output directory, reaching the stack through app.exec —
// and the git ronin needs there (what changed) runs as that user too.
// Outside it (no agent users), ronin's worktree, as before.

// Its own directory name (prototype-portal-p-<n>, prototype-portal-r-<n>), so
// neither sweepOrphanedWorktrees (ronin-<n>-…) nor exploration (app-<name>)
// nor the preview sweep (preview-pr-<n>) ever touches it.
export function prototypeDir(key: string): string {
  return join(activeRepo().worktreeBasePath, `prototype-${key}`);
}

// One prototype at a time per repo: each brings a whole app stack up, next
// to whatever previews and exploration are already running.
const lock = () => worktreeLock('prototype');

export function prototypeWorkerBusy(): Promise<boolean> {
  return lock().busy();
}

// Waits its turn instead of giving up: the comment was already marked done,
// so a worker that left would drop the request for good.
// `onWait` runs once, when the lock is taken and it starts waiting.
export function waitForPrototypeLock(opts: { intervalMs?: number; timeoutMs?: number; onWait?: () => void | Promise<void> } = {}): Promise<boolean> {
  return lock().wait(opts);
}

export function releasePrototypeLock(): Promise<void> {
  return lock().release();
}

// "Admin" → "admin", "Bodega Central" → "bodega-central": an MCP server name.
export function serverName(role: string, viewport: 'desktop' | 'mobile'): string {
  const slug = role.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rol';
  return `${slug}-${viewport}`;
}

export function prototypeBrowsers(app: Pick<AppDefinition, 'users'>): PrototypeBrowser[] {
  const seen = new Set<string>();
  const browsers: PrototypeBrowser[] = [];
  for (const user of app.users) {
    for (const viewport of ['desktop', 'mobile'] as const) {
      const server = serverName(user.role, viewport);
      if (seen.has(server)) continue;
      seen.add(server);
      browsers.push({ server, role: user.role, viewport, ...(user.notes ? { notes: user.notes } : {}) });
    }
  }
  return browsers;
}

export interface PrototypeImage {
  // Absolute, inside the run's output dir.
  imagen: string;
  nota?: string;
}

export type PrototypeOutput = { resumen: string; mensaje?: string; equipo?: TeamNotes; bitacora?: Learned; antes: PrototypeImage[]; despues: PrototypeImage[] } | { error: string };

const MAX_IMAGES = 3;

function images(value: unknown, outDir: string): PrototypeImage[] {
  if (!Array.isArray(value)) return [];
  const result: PrototypeImage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { imagen, nota } = item as { imagen?: unknown; nota?: unknown };
    const path = insideDir(imagen, outDir);
    if (!path || !/\.(png|jpe?g|html?)$/i.test(path)) continue;
    result.push({ imagen: path, ...(typeof nota === 'string' && nota.trim() ? { nota: nota.trim().slice(0, 200) } : {}) });
  }
  return result.slice(0, MAX_IMAGES);
}

export function parsePrototypeResult(raw: string, outDir: string): PrototypeOutput {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('el resultado no es un objeto JSON');
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === 'string' && obj.error.trim()) return { error: obj.error.trim().slice(0, 1_000) };
  const after = images(obj.despues, outDir);
  if (after.length === 0) throw new Error('el resultado no trae ninguna imagen del después');
  const summary = typeof obj.resumen === 'string' && obj.resumen.trim() ? obj.resumen.trim().slice(0, 2_000) : 'Prototipo del cambio pedido.';
  const mensaje = typeof obj.mensaje === 'string' && obj.mensaje.trim() ? obj.mensaje.trim().slice(0, 2_000) : undefined;
  const equipo = parseTeamNotes(obj.equipo);
  const bitacora = parseLearned(obj.bitacora);
  return { resumen: summary, ...(mensaje ? { mensaje } : {}), ...(equipo ? { equipo } : {}), ...(bitacora ? { bitacora } : {}), antes: images(obj.antes, outDir), despues: after };
}

// A shot ready to deliver: always an image file (an HTML after is rendered),
// still inside the run's output dir.
export interface PrototypeShot {
  path: string;
  nota?: string;
  viewport: 'desktop' | 'mobile';
}

export interface PrototypeDraft {
  appName: string;
  resumen: string;
  // The same for the dev who decides, in parts (#406).
  team?: TeamNotes;
  // What the agent wrote for whoever asked, when the task asks for it (the
  // request portal).
  mensaje?: string;
  antes: PrototypeShot[];
  despues: PrototypeShot[];
  patch: string;
  // The script its captures came from (#411), when it wrote one.
  script?: string;
  // What it learned about the app, for its bitácora (#412).
  learned?: Learned;
}

// The agent said no meaningful prototype could be made (its "error"), as
// opposed to the run failing: trying again won't change its mind.
export class PrototypeDeclined extends Error {}

// What every task run on the app gets, from runOnApp.
export interface PrototypeTaskBase extends RunningApp {
  checkoutDir: string;
  outputPath: string;
  mcpConfigPath: string;
  // The captures from a script (#411): the command that runs one, to which
  // the agent adds its script and the phase, and where it writes it.
  shots: { command: string; scriptPath: string };
}

// bin/ronin-shots.mjs, next to ronin's own code: in the image, /app/bin. It
// imports ronin's Playwright from there.
const SHOTS_BIN = resolve('bin', 'ronin-shots.mjs');

export interface PrototypeTarget {
  // Names the checkout, the app instance and the output dir: portal-p-<n>
  // or portal-r-<n>, never shared between two runs.
  key: string;
  appName: string;
  // `app`: the app's stack, for a task that runs tests in it (a portal
  // reproduction, #137, through app.exec). `stage`: copies a file the
  // agent has to read (a request's image, in ronin's data) into the output
  // dir, and gives the copy's path.
  task: (base: PrototypeTaskBase, extra: { app: RunApp; stage: (path: string) => Promise<string> }) => AgentTask | Promise<AgentTask>;
}

// The request's conversation for the agent, each image staged where it
// can read it (runOnApp's `stage`): the request's own are in ronin's data.
export async function stagedConversation(request: Pick<PortalRequest, 'number' | 'messages'>, stage: (path: string) => Promise<string>) {
  const conversation = [];
  for (const m of request.messages) {
    const images = [];
    for (const file of m.images) images.push(await stage(requestImagePath(request.number, file)));
    conversation.push({ from: m.from, text: m.text, images });
  }
  return conversation;
}

// What a run on the app left, for whoever reads its result: while it lasts,
// its output dir and checkout still exist.
export interface AppRun {
  appName: string;
  dir: string;
  outDir: string;
  outputPath: string;
  // What the app's own startup changed, left out of the diff.
  generated: string[];
  // The draft the agent left in the checkout, as a diff (draftDiff).
  diff: () => Promise<string>;
  // A screenshot or an HTML file the agent named, as an image file.
  shot: (path: string, name: string) => Promise<{ path: string; viewport: 'desktop' | 'mobile' }>;
  // The script of captures the agent left (#411), if any.
  script: () => Promise<string | undefined>;
}

// Detached at the base branch, fresh every time: a prototype starts from
// what's on main today, never from a previous prototype's leftovers.
async function freshCheckout(key: string, user: AgentUser | null): Promise<string> {
  const dir = prototypeDir(key);
  const repo = activeRepo().productRepoPath;
  const base = activeRepo().worktreeBaseRef ?? config.worktreeBaseRef;
  if (await host().fs.exists(dir)) {
    await appDown(dir);
    await removeAppCheckout(dir, 'prototype');
  }
  await host().exec('git', ['fetch', 'origin'], { cwd: repo });
  await host().fs.mkdir(activeRepo().worktreeBasePath, { recursive: true });
  if (user) return agentCloneAt(dir, base, user);
  await host().exec('git', ['worktree', 'add', '--detach', dir, base], { cwd: repo });
  return dir;
}

// git in the checkout: as the agent's user when it is its clone.
const gitIn = (dir: string, user: AgentUser | null, args: string[]) =>
  host().exec('git', args, user ? asAgent(user, { cwd: dir, maxBuffer: 16 * 1024 * 1024 }) : { cwd: dir, maxBuffer: 16 * 1024 * 1024 });

// Files that differ from the base right after the app came up: what its
// build generates (e.g. a .NET API's documentation XML), not the draft.
export async function changedFiles(dir: string, user: AgentUser | null = null): Promise<string[]> {
  const { stdout } = await gitIn(dir, user, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = stdout.split('\0');
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    files.push(entries[i].slice(3));
    // A rename or copy is followed by its original path.
    if (/^[RC]/.test(entries[i])) i++;
  }
  return files;
}

// Paths per git diff: a draft is a handful of files, but one that touches
// many still stays well under the argv limit.
const DIFF_BATCH = 200;

// The draft change the agent left in the checkout, new files included, and
// leaving out what the app's own startup had already changed. The startup
// can leave thousands of files (a build's output): they're filtered here,
// never passed to git as pathspecs, which overflowed argv (spawn E2BIG).
export async function draftDiff(dir: string, generated: string[] = [], user: AgentUser | null = null): Promise<string> {
  await gitIn(dir, user, ['add', '-A', '-N']).catch(() => {});
  const skip = new Set(generated);
  const { stdout: names } = await gitIn(dir, user, ['diff', '--name-only', '--no-renames', '-z']);
  const draft = names.split('\0').filter((file) => file && !skip.has(file));
  const parts: string[] = [];
  for (let i = 0; i < draft.length; i += DIFF_BATCH) {
    const paths = draft.slice(i, i + DIFF_BATCH).map((file) => `:(literal)${file}`);
    const { stdout } = await gitIn(dir, user, ['diff', '--no-renames', '--', ...paths]);
    if (stdout.trim()) parts.push(stdout.trim());
  }
  return parts.join('\n');
}


// Brings the app up from a fresh checkout, with one logged-in browser per
// role and viewport, runs the agent on it and hands what it left to
// `collect`: everything is thrown away right after.
export async function runOnApp<T>(target: PrototypeTarget, collect: (run: AppRun) => Promise<T>): Promise<T> {
  const { key, appName } = target;
  const user = repoAgentUser();
  if (user) await prepareAgentUser(user);
  const dir = await freshCheckout(key, user);
  const outDir = join(activeRepo().worktreeBasePath, 'prototype-out', `${key}-${Date.now()}`);
  try {
    const app = await loadAppDefinition(dir, appName);
    const session = await appUp(dir, appName, { instance: key, ...(user ? { as: user } : {}) });
    const authStates = await loginAllUsers(session);
    const generated = await changedFiles(dir, user).catch(() => []);
    const origins = originsOf(session.baseUrl, session.ctx.ports, session.ctx.port);
    const browsers = prototypeBrowsers(app);
    await host().fs.mkdir(outDir, { recursive: true });
    // Everything the agent's browsers read goes in its output dir: the
    // logins, too — the app's state, where appUp left them, isn't its.
    await host().fs.mkdir(join(outDir, 'auth'), { recursive: true });
    const servers: Record<string, unknown> = {};
    const shotBrowsers: Record<string, unknown> = {};
    for (const b of browsers) {
      await host().fs.mkdir(join(outDir, b.server), { recursive: true });
      const login = join(outDir, 'auth', basename(authStates[b.role]));
      await host().fs.writeFile(login, await host().fs.readFile(authStates[b.role]));
      servers[b.server] = mcpServer(app, b.viewport, login, join(outDir, b.server), origins);
      const vp = app.viewports[b.viewport];
      shotBrowsers[b.server] = { storageState: login, viewport: { width: vp.width, height: vp.height }, mobile: Boolean(vp.isMobile), outputDir: join(outDir, b.server), origins };
    }
    const mcpConfigPath = join(outDir, 'mcp.json');
    await host().fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: servers }, null, 2));
    // The same browsers for a script of captures (bin/ronin-shots.mjs).
    const shotsConfigPath = join(outDir, 'browsers.json');
    await host().fs.writeFile(shotsConfigPath, JSON.stringify({ baseUrl: session.baseUrl, browsers: shotBrowsers }, null, 2));
    const outputPath = join(outDir, 'result.json');
    let staged = 0;
    const stage = async (path: string) => {
      const copy = join(outDir, 'request', `${++staged}-${basename(path)}`);
      await host().fs.mkdir(join(outDir, 'request'), { recursive: true });
      await host().fs.writeFile(copy, await host().fs.readFile(path));
      return copy;
    };
    await runAgentTask(await target.task({
      appName,
      appPath: app.path,
      checkoutDir: dir,
      outDir,
      outputPath,
      mcpConfigPath,
      baseUrl: session.baseUrl,
      homePath: app.homePath ?? '/',
      browsers,
      shots: { command: `node ${SHOTS_BIN} ${shotsConfigPath}`, scriptPath: join(outDir, 'guion.json') },
    }, { app: appStack(dir, user), stage }));
    // A screenshot lands in the folder of the browser that took it; an HTML
    // file sits at the top of outDir and renders at desktop size.
    const shot = async (path: string, name: string) => {
      const folder = basename(join(path, '..'));
      const viewport = browsers.find((b) => b.server === folder)?.viewport ?? 'desktop';
      if (!/\.html?$/i.test(path)) return { path, viewport };
      const png = join(outDir, `${name}-render.png`);
      await renderHtmlToPng(path, png, app.viewports[viewport]);
      return { path: png, viewport };
    };
    const script = () => host().fs.readFile(join(outDir, 'guion.json'), 'utf8').then((raw) => raw.trim() || undefined, () => undefined);
    return await collect({ appName, dir, outDir, outputPath, generated, diff: () => draftDiff(dir, generated, user), shot, script });
  } finally {
    await appDown(dir);
    await removeAppCheckout(dir, 'prototype');
    await host().fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A prototype: the agent takes the before, makes the draft and takes the
// after, and `deliver` gets them while the images still exist.
export function makePrototype<T>(target: PrototypeTarget, deliver: (draft: PrototypeDraft) => Promise<T>): Promise<T> {
  return runOnApp(target, async (run) => {
    const output = parsePrototypeResult(await host().fs.readFile(run.outputPath, 'utf8'), run.outDir);
    if ('error' in output) throw new PrototypeDeclined(output.error);
    const shots = { antes: [] as PrototypeShot[], despues: [] as PrototypeShot[] };
    const script = await run.script();
    for (const kind of ['antes', 'despues'] as const) {
      for (const [i, image] of output[kind].entries()) {
        shots[kind].push({ ...(await run.shot(image.imagen, `${kind}-${i + 1}`)), ...(image.nota ? { nota: image.nota } : {}) });
      }
    }
    return deliver({
      appName: run.appName,
      resumen: output.resumen,
      ...(output.equipo ? { team: output.equipo } : {}),
      ...(output.mensaje ? { mensaje: output.mensaje } : {}),
      ...shots,
      patch: await run.diff(),
      ...(script ? { script } : {}),
      ...(output.bitacora ? { learned: output.bitacora } : {}),
    });
  });
}
