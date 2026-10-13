import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRepo } from './repo-context.js';
import { appDown, appUp, APP_STATE_DIR, type AppSession } from './app-runtime.js';
import { APP_MANIFEST_FILE, parseAppManifest, publicizeTemplate, publicPortsIn, publicUrl, type AppStep, type AppUser, type TemplateContext } from './app-manifest.js';
import { removeWorktreeDir } from './worktree.js';
import { listOpenPrNumbers, type PrHead } from './github.js';
import { runAgentTask } from './agent-task.js';
import { HELP_FOOTER_MARKER } from './help.js';
import { config } from './config.js';
import { acquireLock, launchWorker, lockHeld } from './worker-launch.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// `/preview [app]` on a PR: ronin brings the app up from the PR's head, with
// its seeds, in a worktree of its own, and publishes it on the tailnet with
// `tailscale serve` so whoever asked can try it from their own machine. It
// lives until the PR merges or closes (sweepPreviews, on the tick that
// event wakes up) or until `/preview stop`. See docs/DESIGN.md §12.

export interface PreviewWorkerRequest {
  repo: string;
  prNumber: number;
  action: 'up' | 'stop';
  // What followed the command: an app and/or what the data should look
  // like — see resolvePreviewArgs.
  args?: string;
  // The /preview comment, to answer in its own place.
  comment: { id: number; kind: 'issue' | 'review' };
}

export function launchPreviewWorker(request: PreviewWorkerRequest): void {
  const pid = launchWorker('preview-worker', request);
  log.info(`preview: worker lanzado para el PR #${request.prNumber} (${request.action}, pid ${pid})`);
}

// Its own directory name, so neither sweepOrphanedWorktrees (ronin-<n>-…)
// nor exploration (app-<name>) ever touches it.
const PREVIEW_DIR_RE = /^preview-pr-(\d+)$/;

export function previewDirFor(prNumber: number): string {
  return join(activeRepo().worktreeBasePath, `preview-pr-${prNumber}`);
}

export function previewPrFromDirName(name: string): number | null {
  const match = name.match(PREVIEW_DIR_RE);
  return match ? Number(match[1]) : null;
}

// One worker per PR at a time: a second /preview while the first is still
// installing would fight it over the same worktree and stack.
function lockPath(prNumber: number): string {
  return join(activeRepo().worktreeBasePath, `.preview-pr-${prNumber}.lock`);
}

export function previewWorkerBusy(prNumber: number): Promise<boolean> {
  return lockHeld(lockPath(prNumber));
}

export function acquirePreviewLock(prNumber: number): Promise<boolean> {
  return acquireLock(lockPath(prNumber));
}

export async function releasePreviewLock(prNumber: number): Promise<void> {
  await rm(lockPath(prNumber), { force: true });
}

// --- tailscale ---

// The runner's MagicDNS name (e.g. media.tail758870.ts.net), the host every
// preview URL is served on.
export async function tailnetHost(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('tailscale', ['status', '--json']));
  } catch (error) {
    throw new Error(`no pude leer el estado de tailscale en el runner: ${(error as Error).message.split('\n')[0]}`);
  }
  const name = String(JSON.parse(stdout).Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name) throw new Error('tailscale no devolvió el nombre de este host: ¿está conectado a la tailnet?');
  return name;
}

// HTTPS on the same port number the app listens on locally: tailscale serve
// listens on the tailnet address and proxies to loopback, so the two never
// collide, and the public URL is the local one with another host. Tailnet
// only — never `funnel`.
async function servePort(port: number): Promise<void> {
  await execFileAsync('tailscale', ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]);
}

async function unservePort(port: number): Promise<void> {
  await execFileAsync('tailscale', ['serve', `--https=${port}`, 'off'])
    .catch((error) => log.error(`preview: 'tailscale serve --https=${port} off' falló`, error));
}

// --- the preview itself ---

interface PreviewState {
  prNumber: number;
  appName: string;
  sha: string;
  url: string;
  ports: number[];
}

function previewStatePath(dir: string): string {
  return join(dir, APP_STATE_DIR, 'preview.json');
}

async function readPreviewState(dir: string): Promise<PreviewState | null> {
  try {
    return JSON.parse(await readFile(previewStatePath(dir), 'utf8')) as PreviewState;
  } catch {
    return null;
  }
}

// Read the way appUp renders them: a `start` step's env goes through
// publicizeTemplate.
function stepTemplates(step: AppStep): string[] {
  if ('run' in step) return [step.run, ...Object.values(step.env ?? {})];
  if ('start' in step) return [step.start, ...Object.values(step.env ?? {}).map(publicizeTemplate)];
  if ('wait' in step) return [step.wait];
  return [];
}

// What has to be on the tailnet for the app to work from another machine:
// the page itself (baseUrl's port) first, then every port the app hands to
// the browser — a loopback URL in a `start` step's env (the API an SPA
// calls), or anything the manifest marks `{{public.…}}` explicitly.
export function previewPorts(session: Pick<AppSession, 'app' | 'ctx' | 'baseUrl'>): number[] {
  const basePort = Number(new URL(session.baseUrl).port);
  if (!basePort) throw new Error(`el baseUrl de la app (${session.baseUrl}) no tiene un puerto explícito`);
  const declared = session.app.steps.flatMap(stepTemplates).flatMap((t) => publicPortsIn(t, session.ctx));
  return [...new Set([basePort, ...declared])];
}

async function manifestAppNames(dir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, APP_MANIFEST_FILE), 'utf8');
  } catch {
    throw new Error(`este PR no tiene un ${APP_MANIFEST_FILE}: no sé cómo levantar la app`);
  }
  return Object.keys(parseAppManifest(raw).apps);
}

// `/preview backoffice un cliente con 40 catálogos`, `/preview un cliente
// con 40 catálogos` and `/preview` all work: the first word is the app only
// when the manifest has an app by that name; otherwise the manifest's only
// app is used and everything is the instruction for the data.
export function resolvePreviewArgs(args: string | undefined, appNames: string[]): { appName: string; instruction?: string } {
  const text = (args ?? '').trim();
  const first = text.split(/\s+/)[0];
  const named = appNames.find((name) => name.toLowerCase() === first.toLowerCase());
  if (named) {
    const instruction = text.slice(first.length).trim();
    return instruction ? { appName: named, instruction } : { appName: named };
  }
  if (appNames.length !== 1) {
    throw new Error(`hay varias apps en ${APP_MANIFEST_FILE} (${appNames.join(', ')}): pedí \`/preview <app>\``);
  }
  return text ? { appName: appNames[0], instruction: text } : { appName: appNames[0] };
}

function isLiveWorktree(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return Promise.resolve(false);
  return execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    .then(({ stdout }) => stdout.trim() === 'true', () => false);
}

// Detached at the PR's head SHA, fetched through refs/pull/<n>/head like an
// external review's worktree. A live one is reused (its node_modules make a
// second /preview much faster) and moved to the new head.
async function ensurePreviewWorktree(prNumber: number, sha: string): Promise<string> {
  const dir = previewDirFor(prNumber);
  const repo = activeRepo().productRepoPath;
  await execFileAsync('git', ['fetch', 'origin', `pull/${prNumber}/head`], { cwd: repo });
  if (await isLiveWorktree(dir)) {
    await execFileAsync('git', ['checkout', '--detach', '--force', sha], { cwd: dir });
  } else {
    if (existsSync(dir)) await removeWorktreeDir(dir, 'ensurePreviewWorktree');
    await mkdir(activeRepo().worktreeBasePath, { recursive: true });
    await execFileAsync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repo });
  }
  return dir;
}

// Unpublishes and stops whatever preview `dir` has up, keeping the worktree.
// Never throws, like appDown.
async function takeDownPreviewApp(dir: string): Promise<void> {
  const state = await readPreviewState(dir);
  for (const port of state?.ports ?? []) await unservePort(port);
  await appDown(dir);
  await rm(previewStatePath(dir), { force: true });
}

// What prepare-preview-data left ready, or why it couldn't run — the preview
// is delivered either way.
export type PreviewData =
  | { preparado: string[]; noPreparado: string[] }
  | { error: string };

export interface PreviewResult {
  appName: string;
  sha: string;
  url: string;
  users: AppUser[];
  data?: PreviewData;
}

export function parsePreviewData(raw: string): { preparado: string[]; noPreparado: string[] } {
  const parsed = JSON.parse(raw) as { preparado?: unknown; noPreparado?: unknown };
  const lines = (value: unknown) => (Array.isArray(value) ? value.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()) : []);
  return { preparado: lines(parsed.preparado), noPreparado: lines(parsed.noPreparado) };
}

function describeServices(ctx: TemplateContext): string {
  const compose = Object.entries(ctx.ports).flatMap(([service, byTarget]) =>
    Object.entries(byTarget).map(([target, port]) => `- ${service}:${target} → http://127.0.0.1:${port}`));
  const named = Object.entries(ctx.port).map(([name, port]) => `- ${name} → http://127.0.0.1:${port}`);
  return [...compose, ...named].join('\n');
}

// After the app is up with its base seeds, an agent reads the PR (its
// testing steps, its diff) and whatever the requester asked for, and leaves
// the data that exercises the change — see agent-task.ts. Never fails the
// preview: an app without the extra data is still worth handing over.
async function prepareData(opts: {
  prNumber: number;
  pr: Pick<PrHead, 'title' | 'body' | 'baseRefName' | 'headRefOid'>;
  session: AppSession;
  instruction?: string;
}): Promise<PreviewData> {
  const { prNumber, pr, session } = opts;
  const dir = session.dir;
  const outputPath = join(session.stateDir, 'preview-data.json');
  try {
    await rm(outputPath, { force: true });
    await execFileAsync('git', ['fetch', 'origin', pr.baseRefName], { cwd: activeRepo().productRepoPath });
    const mergeBase = (await execFileAsync('git', ['merge-base', `origin/${pr.baseRefName}`, pr.headRefOid], { cwd: dir })).stdout.trim();
    const stat = (await execFileAsync('git', ['diff', '--stat', mergeBase, pr.headRefOid], { cwd: dir })).stdout.trim();
    await runAgentTask({
      type: 'prepare-preview-data',
      prNumber,
      appName: session.appName,
      appPath: session.app.path,
      checkoutDir: dir,
      outputPath,
      title: pr.title,
      // The cheat sheet ronin appends to its own PRs says nothing about the data.
      body: pr.body.split(HELP_FOOTER_MARKER)[0],
      ...(opts.instruction ? { instruction: opts.instruction } : {}),
      diff: { mergeBase, stat },
      baseUrl: session.baseUrl,
      services: describeServices(session.ctx),
      compose: session.ctx.compose,
      users: session.app.users,
    });
    return parsePreviewData(await readFile(outputPath, 'utf8'));
  } catch (error) {
    log.error(`preview PR #${prNumber}: no se pudieron preparar los datos`, error);
    return { error: (error as Error).message.split('\n')[0].slice(0, 300) };
  } finally {
    // The agent is told never to touch the code, and the dev server is
    // serving it: make sure of it. Ignored files (node_modules, .ronin-app)
    // stay.
    await execFileAsync('git', ['checkout', '--force', '--detach', pr.headRefOid], { cwd: dir })
      .then(() => execFileAsync('git', ['clean', '-fd'], { cwd: dir }))
      .catch((error) => log.error(`preview PR #${prNumber}: no se pudo limpiar el checkout`, error));
  }
}

export async function startPreview(prNumber: number, pr: PrHead, args?: string): Promise<PreviewResult> {
  const host = await tailnetHost();
  const sha = pr.headRefOid;
  const existing = previewDirFor(prNumber);
  if (existsSync(existing)) await takeDownPreviewApp(existing);
  const dir = await ensurePreviewWorktree(prNumber, sha);
  const { appName, instruction } = resolvePreviewArgs(args, await manifestAppNames(dir));
  // appUp tears down what it started if it fails.
  const session = await appUp(dir, appName, { instance: `pr-${prNumber}`, publicHost: host });
  let result: PreviewResult;
  try {
    const ports = previewPorts(session);
    const url = publicUrl(ports[0], { publicHost: host });
    // Written before publishing, so a failure halfway still knows which
    // ports to unpublish.
    const state: PreviewState = { prNumber, appName, sha, url, ports };
    await writeFile(previewStatePath(dir), JSON.stringify(state, null, 2));
    for (const port of ports) await servePort(port);
    log.info(`preview PR #${prNumber}: ${appName} arriba en ${url}`);
    result = { appName, sha, url, users: session.app.users };
  } catch (error) {
    await takeDownPreviewApp(dir);
    throw error;
  }
  if (!config.previewPrepareData) return result;
  return { ...result, data: await prepareData({ prNumber, pr, session, ...(instruction ? { instruction } : {}) }) };
}

// Unpublishes, stops and deletes the PR's preview. False when there was none.
export async function stopPreview(prNumber: number): Promise<boolean> {
  const dir = previewDirFor(prNumber);
  if (!existsSync(dir)) return false;
  await takeDownPreviewApp(dir);
  await removeWorktreeDir(dir, 'stopPreview');
  log.info(`preview PR #${prNumber}: bajada y worktree borrado`);
  return true;
}

// A preview lives as long as its PR: once it's merged or closed, its app,
// its tailnet ports and its worktree go. Runs every tick, and a merge wakes
// one up through the webhook (pull_request closed), so it goes right after.
// Costs nothing when there are no previews: the PR list is only read if
// there's a preview worktree on disk. A preview whose worker is still running
// waits for the next tick.
export async function sweepPreviews(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(activeRepo().worktreeBasePath);
  } catch {
    return;
  }
  const previews = entries.flatMap((name) => {
    const pr = previewPrFromDirName(name);
    return pr === null ? [] : [pr];
  });
  if (previews.length === 0) return;
  const open = new Set(await listOpenPrNumbers());
  for (const pr of previews) {
    if (open.has(pr) || (await previewWorkerBusy(pr))) continue;
    log.info(`preview PR #${pr}: el PR ya no está abierto, bajando su preview`);
    await stopPreview(pr);
  }
}

// --- replies ---

export function renderPreviewStarting(sha: string, withData: boolean): string {
  const data = withData ? ', y después preparo los datos para probar este PR' : '';
  return `⏳ Levantando la app con el código de \`${sha.slice(0, 7)}\` (dependencias, base y seeds${data}). Te aviso acá cuando esté.`;
}

function renderData(data: PreviewData | undefined): string[] {
  if (!data) return [];
  if ('error' in data) return [`⚠️ No pude preparar los datos para probar el PR (${data.error}): la app tiene solo los seeds base.`, ''];
  if (data.preparado.length === 0 && data.noPreparado.length === 0) return ['No hizo falta preparar datos: el PR se prueba con los seeds base.', ''];
  return [
    ...(data.preparado.length > 0 ? ['**Datos listos para probar el PR**', ...data.preparado.map((l) => `- ${l}`), ''] : []),
    ...(data.noPreparado.length > 0 ? ['**Lo que no pude preparar**', ...data.noPreparado.map((l) => `- ${l}`), ''] : []),
  ];
}

export function renderPreviewReady(result: PreviewResult, login: string): string {
  const users = result.users.map((u) => `| ${u.role} | \`${u.username}\` | \`${u.password}\` |`);
  return [
    `🚀 Preview de \`${result.appName}\` lista: **${result.url}**`,
    '',
    `Commit \`${result.sha.slice(0, 7)}\`. Solo se abre desde la tailnet.`,
    '',
    ...renderData(result.data),
    '| Rol | Usuario | Contraseña |',
    '|---|---|---|',
    ...users,
    '',
    `Se baja sola cuando el PR se mergea o se cierra. Para bajarla antes: \`@${login} /preview stop\`. Con commits nuevos en el PR, volvé a pedir \`/preview\` para actualizarla; lo que escribas después del comando (\`/preview un cliente con 40 catálogos\`) se suma a lo que piden los pasos de prueba.`,
  ].join('\n');
}

export function renderPreviewFailed(error: Error): string {
  const [first, ...rest] = error.message.split('\n');
  const detail = rest.join('\n').trim();
  return [
    `❌ No pude levantar la app: ${first.slice(0, 300)}`,
    ...(detail ? ['', '<details><summary>Últimas líneas del log</summary>', '', '```', detail.slice(-3000), '```', '</details>'] : []),
  ].join('\n');
}
