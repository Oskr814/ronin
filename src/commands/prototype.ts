import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runAgentTask, type PrototypeBrowser } from '../core/agent-task.js';
import { appDown, appUp } from '../app/index.js';
import { loginAllUsers, renderHtmlToPng } from '../app/index.js';
import { loadAppDefinition, type AppDefinition } from '../app/index.js';
import { config } from '../core/config.js';
import { evidenceUrl, publishEvidence } from '../app/index.js';
import { insideDir } from '../exploration/index.js';
import { mcpServer, originsOf } from '../exploration/index.js';
import { activeRepo } from '../core/repo-context.js';
import { acquireLock, launchWorker, lockHeld } from '../core/worker-launch.js';
import { removeWorktreeDir } from '../core/worktree.js';
import { log } from '../core/logger.js';

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
  const pid = launchWorker('commands/prototype-worker', request);
  log.info(`prototipo: worker lanzado para el issue #${request.issueNumber} (${request.appName}, pid ${pid})`);
}

// Its own directory name, so neither sweepOrphanedWorktrees (ronin-<n>-…)
// nor exploration (app-<name>) nor the preview sweep (preview-pr-<n>) ever
// touches it.
export function prototypeDirFor(issueNumber: number): string {
  return join(activeRepo().worktreeBasePath, `prototype-issue-${issueNumber}`);
}

// One prototype at a time per repo: each brings a whole app stack up, next
// to whatever previews and exploration are already running.
function lockPath(): string {
  return join(activeRepo().worktreeBasePath, '.prototype.lock');
}

export function prototypeWorkerBusy(): Promise<boolean> {
  return lockHeld(lockPath());
}

// Waits its turn instead of giving up: the comment was already marked done,
// so a worker that left would drop the request for good.
export async function waitForPrototypeLock(opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 30_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 60_000);
  for (;;) {
    if (await acquireLock(lockPath())) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function releasePrototypeLock(): Promise<void> {
  await rm(lockPath(), { force: true });
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

export type PrototypeOutput = { resumen: string; antes: PrototypeImage[]; despues: PrototypeImage[] } | { error: string };

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
  return { resumen, antes: images(obj.antes, outDir), despues };
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

// Detached at the base branch, fresh every time: a prototype starts from
// what's on main today, never from a previous prototype's leftovers.
async function freshWorktree(issueNumber: number): Promise<string> {
  const dir = prototypeDirFor(issueNumber);
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

// The draft change the agent left in the checkout, new files included.
async function draftDiff(dir: string): Promise<string> {
  await execFileAsync('git', ['add', '-A', '-N'], { cwd: dir }).catch(() => {});
  const { stdout } = await execFileAsync('git', ['diff'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function publishImages(
  issueNumber: number,
  shots: { antes: PrototypeImage[]; despues: PrototypeImage[] },
  ctx: { app: AppDefinition; outDir: string; viewportOf: (path: string) => 'desktop' | 'mobile' },
): Promise<{ antes: PublishedImage[]; despues: PublishedImage[] }> {
  const prefix = `issues/${issueNumber}/prototipo-${Date.now()}`;
  const files: Array<{ src: string; path: string }> = [];
  const meta: Array<{ kind: 'antes' | 'despues'; nota?: string; viewport: 'desktop' | 'mobile'; path: string }> = [];
  for (const kind of ['antes', 'despues'] as const) {
    for (const [i, shot] of shots[kind].entries()) {
      const viewport = ctx.viewportOf(shot.imagen);
      let src = shot.imagen;
      if (/\.html?$/i.test(src)) {
        src = join(ctx.outDir, `${kind}-${i + 1}-render.png`);
        await renderHtmlToPng(shot.imagen, src, ctx.app.viewports[viewport]);
      }
      const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
      const path = `${prefix}/${kind}-${i + 1}${ext}`;
      files.push({ src, path });
      meta.push({ kind, viewport, path, ...(shot.nota ? { nota: shot.nota } : {}) });
    }
  }
  const sha = await publishEvidence(activeRepo().productRepoPath, files, `prototipo del issue #${issueNumber}`);
  const published = { antes: [] as PublishedImage[], despues: [] as PublishedImage[] };
  for (const m of meta) published[m.kind].push({ url: evidenceUrl(sha, m.path), viewport: m.viewport, ...(m.nota ? { nota: m.nota } : {}) });
  return published;
}

export async function runPrototype(request: Pick<PrototypeWorkerRequest, 'issueNumber' | 'appName' | 'instruction'>): Promise<PrototypeResult> {
  const { issueNumber, appName } = request;
  const dir = await freshWorktree(issueNumber);
  const outDir = join(activeRepo().worktreeBasePath, 'prototype-out', `${issueNumber}-${Date.now()}`);
  try {
    const app = await loadAppDefinition(dir, appName);
    const session = await appUp(dir, appName, { instance: `issue-${issueNumber}` });
    const authStates = await loginAllUsers(session);
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
    await runAgentTask({
      type: 'prototype',
      issueNumber,
      appName,
      appPath: app.path,
      checkoutDir: dir,
      outDir,
      outputPath,
      mcpConfigPath,
      baseUrl: session.baseUrl,
      homePath: app.homePath ?? '/',
      browsers,
      ...(request.instruction ? { instruction: request.instruction } : {}),
    });
    const output = parsePrototypeResult(await readFile(outputPath, 'utf8'), outDir);
    if ('error' in output) throw new Error(output.error);
    // A screenshot lands in the folder of the browser that took it; an HTML
    // after sits at the top of outDir and renders at desktop size.
    const viewportOf = (path: string): 'desktop' | 'mobile' => {
      const folder = basename(join(path, '..'));
      return browsers.find((b) => b.server === folder)?.viewport ?? 'desktop';
    };
    const published = await publishImages(issueNumber, output, { app, outDir, viewportOf });
    return { appName, resumen: output.resumen, ...published, patch: await draftDiff(dir) };
  } finally {
    await appDown(dir);
    await removeWorktreeDir(dir, 'prototype');
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
