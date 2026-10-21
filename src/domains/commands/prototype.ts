import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runAgentTask, type AgentTask } from '../../platform/agents/agent-task.js';
import { commandTask, type CommandTask, type PrototypeBrowser } from './prompts.js';
import { appDown, appUp } from '../product-app/index.js';
import { loginAllUsers, renderHtmlToPng } from '../product-app/index.js';
import { loadAppDefinition, type AppDefinition } from '../product-app/index.js';
import { config } from '../../platform/config/config.js';
import { evidenceUrl, publishEvidence } from '../product-app/index.js';
import { insideDir } from '../explorations/index.js';
import { mcpServer, originsOf } from '../explorations/index.js';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { launchWorker } from '../../platform/workers/worker-launch.js';
import { removeWorktreeDir } from '../../platform/git/worktree.js';
import { log } from '../../platform/logger.js';
import { worktreeLock } from '../../platform/workers/worktree-lock.js';

const execFileAsync = promisify(execFile);

// `/prototype <app> [instrucción]` on an issue, or a plain-words request for
// one (issue-request.ts): ronin brings the app up from the base branch in a
// worktree of its own, an agent takes the before, makes a draft change and
// takes the after, and the images (evidence branch) and the draft's diff go
// on the issue as a comment. No branch is pushed and no PR is opened: the
// worktree is thrown away. Runs in its own process (prototype-worker.ts),
// one at a time per repo. See docs/DESIGN.md §11.11.

export interface PrototypeWorkerRequest {
  repo: string;
  issueNumber: number;
  appName: string;
  instruction?: string;
  // The comment that asked for it, answered with the result.
  commentId: number;
}

export function launchPrototypeWorker(request: PrototypeWorkerRequest): void {
  const pid = launchWorker('domains/commands/prototype-worker', request);
  log.info(`prototipo: worker lanzado para el issue #${request.issueNumber} (${request.appName}, pid ${pid})`);
}

// Its own directory name (prototype-issue-<n>, prototype-portal-p-<n>), so
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

export type PrototypeOutput = { resumen: string; mensaje?: string; antes: PrototypeImage[]; despues: PrototypeImage[] } | { error: string };

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
  const despues = images(obj.despues, outDir);
  if (despues.length === 0) throw new Error('el resultado no trae ninguna imagen del después');
  const resumen = typeof obj.resumen === 'string' && obj.resumen.trim() ? obj.resumen.trim().slice(0, 2_000) : 'Prototipo del cambio que pide el issue.';
  const mensaje = typeof obj.mensaje === 'string' && obj.mensaje.trim() ? obj.mensaje.trim().slice(0, 2_000) : undefined;
  return { resumen, ...(mensaje ? { mensaje } : {}), antes: images(obj.antes, outDir), despues };
}

export interface PublishedImage {
  url: string;
  nota?: string;
  viewport: 'desktop' | 'mobile';
}

export interface PrototypeResult {
  appName: string;
  resumen: string;
  antes: PublishedImage[];
  despues: PublishedImage[];
  patch: string;
}

// GitHub caps a comment at 65 536 characters; the images and text above the
// diff take a few thousand at most.
const MAX_PATCH = 40_000;

function imageTag(img: PublishedImage): string {
  const alt = (img.nota ?? 'captura').replace(/"/g, "'");
  return `<img src="${img.url}" alt="${alt}" width="${img.viewport === 'mobile' ? 320 : 720}">`;
}

export function renderPrototypeComment(result: PrototypeResult, login: string): string {
  const lines = [`### Prototipo en \`${result.appName}\``, '', result.resumen, ''];
  const pairs = Math.max(result.antes.length, result.despues.length);
  for (let i = 0; i < pairs; i++) {
    const antes = result.antes[i];
    const despues = result.despues[i];
    if (antes) lines.push(`**Antes**${antes.nota ? `: ${antes.nota}` : ''}`, '', imageTag(antes), '');
    if (despues) lines.push(`**Después**${despues.nota ? `: ${despues.nota}` : ''}`, '', imageTag(despues), '');
  }
  if (result.patch) {
    const patch = result.patch.length > MAX_PATCH ? `${result.patch.slice(0, MAX_PATCH)}\n… (recortado)` : result.patch;
    lines.push('<details><summary>Cambio borrador usado para el después</summary>', '', '```diff', patch, '```', '', '</details>', '');
  }
  lines.push(`_Es un borrador para discutir: no hay rama ni PR. Para que lo implemente, asigname el issue; para cambiar el prototipo, pedímelo con \`@${login}\` acá mismo._`);
  return lines.join('\n');
}

export function renderPrototypeFailed(reason: string): string {
  return `No pude hacer el prototipo: ${reason.split('\n')[0].slice(0, 300)}`;
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
  // What the agent wrote for whoever asked, when the task asks for it (the
  // request portal).
  mensaje?: string;
  antes: PrototypeShot[];
  despues: PrototypeShot[];
  patch: string;
}

// The agent said no meaningful prototype could be made (its "error"), as
// opposed to the run failing: trying again won't change its mind.
export class PrototypeDeclined extends Error {}

export type PrototypeTaskBase = Omit<Extract<CommandTask, { type: 'prototype' }>, 'type' | 'issueNumber' | 'instruction'>;

export interface PrototypeTarget {
  // Names the checkout, the app instance and the output dir: issue-<n>,
  // portal-p-<n> or portal-r-<n>, never shared between two runs.
  key: string;
  appName: string;
  // `compose`: the docker compose command of the app's stack, for a task
  // that runs tests in it (a portal reproduction, #137).
  task: (base: PrototypeTaskBase, extra: { compose: string }) => AgentTask;
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
  // A screenshot or an HTML file the agent named, as an image file.
  shot: (path: string, name: string) => Promise<{ path: string; viewport: 'desktop' | 'mobile' }>;
}

// Detached at the base branch, fresh every time: a prototype starts from
// what's on main today, never from a previous prototype's leftovers.
async function freshWorktree(key: string): Promise<string> {
  const dir = prototypeDir(key);
  const repo = activeRepo().productRepoPath;
  if (existsSync(dir)) {
    await appDown(dir);
    await removeWorktreeDir(dir, 'prototype');
  }
  await execFileAsync('git', ['fetch', 'origin'], { cwd: repo });
  await mkdir(activeRepo().worktreeBasePath, { recursive: true });
  await execFileAsync('git', ['worktree', 'add', '--detach', dir, activeRepo().worktreeBaseRef ?? config.worktreeBaseRef], { cwd: repo });
  return dir;
}

// Files that differ from the base right after the app came up: what its
// build generates (e.g. a .NET API's documentation XML), not the draft.
export async function changedFiles(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
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

// The draft change the agent left in the checkout, new files included, and
// leaving out what the app's own startup had already changed.
export async function draftDiff(dir: string, generated: string[] = []): Promise<string> {
  await execFileAsync('git', ['add', '-A', '-N'], { cwd: dir }).catch(() => {});
  const exclude = generated.map((file) => `:(exclude,literal)${file}`);
  const { stdout } = await execFileAsync('git', ['diff', '--', '.', ...exclude], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// Brings the app up from a fresh checkout, with one logged-in browser per
// role and viewport, runs the agent on it and hands what it left to
// `collect`: everything is thrown away right after.
export async function runOnApp<T>(target: PrototypeTarget, collect: (run: AppRun) => Promise<T>): Promise<T> {
  const { key, appName } = target;
  const dir = await freshWorktree(key);
  const outDir = join(activeRepo().worktreeBasePath, 'prototype-out', `${key}-${Date.now()}`);
  try {
    const app = await loadAppDefinition(dir, appName);
    const session = await appUp(dir, appName, { instance: key });
    const authStates = await loginAllUsers(session);
    const generated = await changedFiles(dir).catch(() => []);
    const origins = originsOf(session.baseUrl, session.ctx.ports, session.ctx.port);
    const browsers = prototypeBrowsers(app);
    await mkdir(outDir, { recursive: true });
    const servers: Record<string, unknown> = {};
    for (const b of browsers) {
      await mkdir(join(outDir, b.server), { recursive: true });
      servers[b.server] = mcpServer(app, b.viewport, authStates[b.role], join(outDir, b.server), origins);
    }
    const mcpConfigPath = join(outDir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: servers }, null, 2));
    const outputPath = join(outDir, 'result.json');
    await runAgentTask(target.task({
      appName,
      appPath: app.path,
      checkoutDir: dir,
      outDir,
      outputPath,
      mcpConfigPath,
      baseUrl: session.baseUrl,
      homePath: app.homePath ?? '/',
      browsers,
    }, { compose: session.ctx.compose }));
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
    return await collect({ appName, dir, outDir, outputPath, generated, shot });
  } finally {
    await appDown(dir);
    await removeWorktreeDir(dir, 'prototype');
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A prototype: the agent takes the before, makes the draft and takes the
// after, and `deliver` gets them while the images still exist.
export function makePrototype<T>(target: PrototypeTarget, deliver: (draft: PrototypeDraft) => Promise<T>): Promise<T> {
  return runOnApp(target, async (run) => {
    const output = parsePrototypeResult(await readFile(run.outputPath, 'utf8'), run.outDir);
    if ('error' in output) throw new PrototypeDeclined(output.error);
    const shots = { antes: [] as PrototypeShot[], despues: [] as PrototypeShot[] };
    for (const kind of ['antes', 'despues'] as const) {
      for (const [i, image] of output[kind].entries()) {
        shots[kind].push({ ...(await run.shot(image.imagen, `${kind}-${i + 1}`)), ...(image.nota ? { nota: image.nota } : {}) });
      }
    }
    return deliver({
      appName: run.appName,
      resumen: output.resumen,
      ...(output.mensaje ? { mensaje: output.mensaje } : {}),
      ...shots,
      patch: await draftDiff(run.dir, run.generated),
    });
  });
}

async function publishImages(issueNumber: number, draft: PrototypeDraft): Promise<{ antes: PublishedImage[]; despues: PublishedImage[] }> {
  const prefix = `issues/${issueNumber}/prototipo-${Date.now()}`;
  const files: Array<{ src: string; path: string }> = [];
  const meta: Array<{ kind: 'antes' | 'despues'; nota?: string; viewport: 'desktop' | 'mobile'; path: string }> = [];
  for (const kind of ['antes', 'despues'] as const) {
    for (const [i, shot] of draft[kind].entries()) {
      const ext = shot.path.slice(shot.path.lastIndexOf('.')).toLowerCase();
      const path = `${prefix}/${kind}-${i + 1}${ext}`;
      files.push({ src: shot.path, path });
      meta.push({ kind, viewport: shot.viewport, path, ...(shot.nota ? { nota: shot.nota } : {}) });
    }
  }
  const sha = await publishEvidence(activeRepo().productRepoPath, files, `prototipo del issue #${issueNumber}`);
  const published = { antes: [] as PublishedImage[], despues: [] as PublishedImage[] };
  for (const m of meta) published[m.kind].push({ url: evidenceUrl(sha, m.path), viewport: m.viewport, ...(m.nota ? { nota: m.nota } : {}) });
  return published;
}

// An issue's prototype: the images go to the evidence branch, for the
// comment that answers whoever asked.
export async function runPrototype(request: Pick<PrototypeWorkerRequest, 'issueNumber' | 'appName' | 'instruction'>): Promise<PrototypeResult> {
  const { issueNumber, appName } = request;
  return makePrototype(
    {
      key: `issue-${issueNumber}`,
      appName,
      task: (base) => commandTask({ type: 'prototype', issueNumber, ...base, ...(request.instruction ? { instruction: request.instruction } : {}) }),
    },
    async (draft) => ({ appName, resumen: draft.resumen, ...(await publishImages(issueNumber, draft)), patch: draft.patch }),
  );
}
