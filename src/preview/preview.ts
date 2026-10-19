import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRepo } from '../core/repo-context.js';
import { appDown, appUp, APP_STATE_DIR, type AppSession } from '../app/index.js';
import { APP_MANIFEST_FILE, parseAppManifest, publicizeTemplate, publicPortsIn, publicUrl, type AppStep, type AppUser, type TemplateContext } from '../app/index.js';
import { removeWorktreeDir } from '../core/worktree.js';
import { commentOnSpecPr, listOpenPrHeads, type PrHead } from '../core/github.js';
import { runAgentTask } from '../core/agent-task.js';
import { previewTask, type PreviewTask } from './prompts.js';
import { parseSeedCatalog, readSeedCatalog, saveSeedCatalog, seedCatalogPath } from './seed-catalog.js';
import { HELP_FOOTER_MARKER } from '../commands/index.js';
import { config } from '../core/config.js';
import { acquireLock, launchWorker, lockHeld } from '../core/worker-launch.js';
import { parsePortRange, PreviewReservations } from './reservations.js';
import { log } from '../core/logger.js';

const execFileAsync = promisify(execFile);

// `/preview [app]` on a PR: ronin brings the app up from the PR's head, with
// its seeds (and the base's ronin.app.json unless the PR changes it), in a worktree of its own, and publishes it on the tailnet with
// `tailscale serve` so whoever asked can try it from their own machine. It
// lives until the PR merges or closes (sweepPreviews, on the tick that
// event wakes up), until `/preview stop`, or until PREVIEW_TTL_MINUTES after
// it came up. See docs/DESIGN.md §12.

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
  const pid = launchWorker('preview/worker', request);
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

// The runner's MagicDNS name (e.g. <host>.<tailnet>.ts.net), the host every
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

// HTTPS on a port of the preview range (PREVIEW_PORT_RANGE), proxied to the
// one the app listens on in loopback. The range is what a tailnet policy
// opens to someone outside, so they reach previews and nothing else on this
// host. Tailnet only — never `funnel`.
async function servePort(publicPort: number, localPort: number): Promise<void> {
  await execFileAsync('tailscale', ['serve', '--bg', `--https=${publicPort}`, `http://127.0.0.1:${localPort}`]);
}

async function unservePort(port: number): Promise<void> {
  await execFileAsync('tailscale', ['serve', `--https=${port}`, 'off'])
    .catch((error) => log.error(`preview: 'tailscale serve --https=${port} off' falló`, error));
}

// --- the preview itself ---

export interface PreviewState {
  prNumber: number;
  appName: string;
  sha: string;
  url: string;
  published?: Array<{ public: number; local: number }>;
  // Before the preview range: published on the local port itself.
  ports?: number[];
  // Set once the PR was told this preview is behind its commits — at most
  // one notice per preview; a new /preview starts a fresh state.
  staleNotified?: boolean;
  // When it came up (ISO), what PREVIEW_TTL_MINUTES counts from. A state
  // from before the TTL has none: the sweep stamps it on first sight.
  startedAt?: string;
  // Up, but prepare-preview-data is still making the data the PR's test
  // steps need: the dashboard says so instead of offering a URL that would
  // be tried without them. Cleared once the data is done (or failed).
  preparing?: boolean;
}

const reservations = (): PreviewReservations => new PreviewReservations(config.previewReservationsDir);

// Per repo, not per app: a repo with several apps still runs at most
// PREVIEW_MAX_PER_REPO previews, whichever apps they are.
function slotKey(): string {
  return activeRepo().productRepo.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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

// Which ronin.app.json brings the preview up: the PR's own when the PR
// changes it, and otherwise its base's. A PR branched before a fix to the
// manifest (Bmedical/bmedical#367, from before ALLOWED_DEV_ORIGINS) would
// otherwise bring the app up broken, and ronin never brings its own PRs up
// to date with their base.
export function chooseManifest(changedByPr: boolean, base: string | null, head: string | null): { raw: string; from: 'pr' | 'base' } | null {
  if (changedByPr && head !== null) return { raw: head, from: 'pr' };
  if (base !== null) return { raw: base, from: 'base' };
  return head !== null ? { raw: head, from: 'pr' } : null;
}

async function previewManifest(dir: string, pr: Pick<PrHead, 'baseRefName' | 'headRefOid'>): Promise<string> {
  const repo = activeRepo().productRepoPath;
  await execFileAsync('git', ['fetch', 'origin', pr.baseRefName], { cwd: repo });
  const baseRef = `origin/${pr.baseRefName}`;
  const mergeBase = (await execFileAsync('git', ['merge-base', baseRef, pr.headRefOid], { cwd: dir })).stdout.trim();
  // Exit code 1 means there's a difference.
  const changedByPr = await execFileAsync('git', ['diff', '--quiet', mergeBase, pr.headRefOid, '--', APP_MANIFEST_FILE], { cwd: dir })
    .then(() => false, () => true);
  const base = await execFileAsync('git', ['show', `${baseRef}:${APP_MANIFEST_FILE}`], { cwd: dir, maxBuffer: 10 * 1024 * 1024 })
    .then(({ stdout }) => stdout, () => null);
  const head = await readFile(join(dir, APP_MANIFEST_FILE), 'utf8').catch(() => null);
  const chosen = chooseManifest(changedByPr, base, head);
  if (!chosen) throw new Error(`ni este PR ni \`${pr.baseRefName}\` tienen un ${APP_MANIFEST_FILE}: no sé cómo levantar la app`);
  log.info(`preview: ${APP_MANIFEST_FILE} ${chosen.from === 'pr' ? 'del PR' : `de ${pr.baseRefName}`}`);
  return chosen.raw;
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
  const published = state?.published?.map((p) => p.public) ?? state?.ports ?? [];
  for (const port of published) await unservePort(port);
  await appDown(dir);
  await reservations().releasePorts(dir);
  await rm(previewStatePath(dir), { force: true });
}

// What prepare-preview-data left ready, or why it couldn't run — the preview
// is delivered either way. `base`: the seeded records to try the PR with,
// when the triage found the base seed enough and nothing was prepared.
export type PreviewData =
  | { preparado: string[]; noPreparado: string[]; base?: string[] }
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
  return { preparado: stringLines(parsed.preparado), noPreparado: stringLines(parsed.noPreparado) };
}

const stringLines = (value: unknown) => (Array.isArray(value) ? value.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()) : []);

// Only an explicit true skips preparing the data.
export function parsePreviewTriage(raw: string): { alcanzan: boolean; usar: string[] } {
  const parsed = JSON.parse(raw) as { alcanzan?: unknown; usar?: unknown };
  return { alcanzan: parsed.alcanzan === true, usar: stringLines(parsed.usar) };
}

function describeServices(ctx: TemplateContext): string {
  const compose = Object.entries(ctx.ports).flatMap(([service, byTarget]) =>
    Object.entries(byTarget).map(([target, port]) => `- ${service}:${target} → http://127.0.0.1:${port}`));
  const named = Object.entries(ctx.port).map(([name, port]) => `- ${name} → http://127.0.0.1:${port}`);
  return [...compose, ...named].join('\n');
}

// What the base seed has, from the catalog for its hash, written now — by
// an agent, before anything else touches the database — when there's none
// yet: that preview takes longer once, and every later one with the same
// seeds starts from it (seed-catalog.ts). Null when it couldn't be written:
// the data is prepared as without a catalog.
async function seedCatalog(prNumber: number, sha: string, session: AppSession): Promise<string | null> {
  try {
    const path = await seedCatalogPath(session.dir, sha, session.appName, session.app);
    const existing = await readSeedCatalog(path);
    if (existing) {
      log.info(`preview PR #${prNumber}: catálogo de seeds ${path}`);
      return existing;
    }
    const outputPath = join(session.stateDir, 'seed-catalog.yaml');
    await rm(outputPath, { force: true });
    await runAgentTask(previewTask({
      type: 'preview-seed-catalog',
      prNumber,
      appName: session.appName,
      appPath: session.app.path,
      checkoutDir: session.dir,
      outputPath,
      baseUrl: session.baseUrl,
      services: describeServices(session.ctx),
      compose: session.ctx.compose,
      users: session.app.users,
    }));
    const catalog = parseSeedCatalog(await readFile(outputPath, 'utf8'));
    await saveSeedCatalog(path, catalog, `${activeRepo().productRepo} · ${session.appName}: lo que traen los seeds base.\nLo escribió ronin en la preview del PR #${prNumber} (${sha.slice(0, 7)}), ${new Date().toISOString()}.`);
    log.info(`preview PR #${prNumber}: catálogo de seeds nuevo en ${path}`);
    return catalog;
  } catch (error) {
    log.error(`preview PR #${prNumber}: no se pudo leer ni escribir el catálogo de seeds`, error);
    return null;
  }
}

// After the app is up with its base seeds: with the catalog of those seeds,
// a small model decides whether they're already enough to try the PR. When
// they aren't (or there's no catalog), an agent reads the PR (its testing
// steps, its diff) and whatever the requester asked for, and leaves the
// data that exercises the change — see prompts.ts. Never fails the
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
    const about = {
      prNumber,
      checkoutDir: dir,
      title: pr.title,
      // The cheat sheet ronin appends to its own PRs says nothing about the data.
      body: pr.body.split(HELP_FOOTER_MARKER)[0],
      ...(opts.instruction ? { instruction: opts.instruction } : {}),
      diff: { mergeBase, stat },
    };
    const catalog = await seedCatalog(prNumber, pr.headRefOid, session);
    if (catalog) {
      const triage = await triageData({ ...about, catalog }, session.stateDir);
      if (triage?.alcanzan) return { preparado: [], noPreparado: [], base: triage.usar };
    }
    await runAgentTask(previewTask({
      type: 'prepare-preview-data',
      ...about,
      appName: session.appName,
      appPath: session.app.path,
      outputPath,
      ...(catalog ? { catalog } : {}),
      baseUrl: session.baseUrl,
      services: describeServices(session.ctx),
      compose: session.ctx.compose,
      users: session.app.users,
    }));
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

// Null when it couldn't decide: the data is prepared as if they weren't enough.
async function triageData(task: Omit<Extract<PreviewTask, { type: 'preview-data-triage' }>, 'type' | 'outputPath'>, stateDir: string): Promise<{ alcanzan: boolean; usar: string[] } | null> {
  const outputPath = join(stateDir, 'preview-triage.json');
  try {
    await rm(outputPath, { force: true });
    await runAgentTask(previewTask({ type: 'preview-data-triage', ...task, outputPath }));
    const triage = parsePreviewTriage(await readFile(outputPath, 'utf8'));
    log.info(`preview PR #${task.prNumber}: ${triage.alcanzan ? 'los seeds base alcanzan' : 'hay que preparar datos'}`);
    return triage;
  } catch (error) {
    log.error(`preview PR #${task.prNumber}: no se pudo decidir si alcanzan los seeds base`, error);
    return null;
  }
}

export async function startPreview(prNumber: number, pr: PrHead, args?: string): Promise<PreviewResult> {
  const host = await tailnetHost();
  const sha = pr.headRefOid;
  const existing = previewDirFor(prNumber);
  if (existsSync(existing)) await takeDownPreviewApp(existing);
  const dir = await ensurePreviewWorktree(prNumber, sha);
  const manifest = await previewManifest(dir, pr);
  const { appName, instruction } = resolvePreviewArgs(args, Object.keys(parseAppManifest(manifest).apps));
  // Checked before anything starts: a preview is a whole stack, and this
  // host runs a handful at most. A second /preview on the same PR keeps its
  // slot.
  const owner = { dir, prNumber };
  const slot = await reservations().acquireSlot(slotKey(), config.previewMaxPerRepo, owner);
  if (!slot.ok) {
    // Nothing of this PR is running: don't leave its checkout behind until
    // the PR closes.
    await removeWorktreeDir(dir, 'startPreview');
    const holders = slot.holders.map((n) => `#${n}`).join(', ');
    const max = config.previewMaxPerRepo;
    throw new Error(`ya hay ${max} ${max === 1 ? 'preview activa' : 'previews activas'} en este repo (${holders}). Bajá una con \`/preview stop\` en su PR, o esperá a que se mergee o se cierre`);
  }
  const range = parsePortRange(config.previewPortRange);
  const publicPort = () => reservations().allocatePort(range, owner);
  let session: AppSession;
  try {
    // appUp tears down what it started if it fails.
    session = await appUp(dir, appName, { instance: `pr-${prNumber}`, publicHost: host, publicPort, manifest });
  } catch (error) {
    await reservations().releasePorts(dir);
    await reservations().releaseSlots(dir);
    throw error;
  }
  let result: PreviewResult;
  try {
    const locals = previewPorts(session);
    const publicPorts = (session.ctx.publicPorts ??= {});
    for (const local of locals) publicPorts[String(local)] ??= await publicPort();
    const published = locals.map((local) => ({ public: publicPorts[String(local)], local }));
    const url = publicUrl(locals[0], session.ctx);
    // Written before publishing, so a failure halfway still knows which
    // ports to unpublish.
    const state: PreviewState = { prNumber, appName, sha, url, published, startedAt: new Date().toISOString(), ...(config.previewPrepareData ? { preparing: true } : {}) };
    await writeFile(previewStatePath(dir), JSON.stringify(state, null, 2));
    for (const p of published) await servePort(p.public, p.local);
    log.info(`preview PR #${prNumber}: ${appName} arriba en ${url}`);
    result = { appName, sha, url, users: session.app.users };
  } catch (error) {
    await takeDownPreviewApp(dir);
    await reservations().releaseSlots(dir);
    throw error;
  }
  if (!config.previewPrepareData) return result;
  const data = await prepareData({ prNumber, pr, session, ...(instruction ? { instruction } : {}) });
  await markPrepared(dir);
  return { ...result, data };
}

async function markPrepared(dir: string): Promise<void> {
  const state = await readPreviewState(dir);
  if (!state?.preparing) return;
  delete state.preparing;
  await writeFile(previewStatePath(dir), JSON.stringify(state, null, 2)).catch((error) => log.error('preview: no se pudo marcar los datos como listos', error));
}

// Unpublishes, stops and deletes the PR's preview. False when there was none.
export async function stopPreview(prNumber: number): Promise<boolean> {
  const dir = previewDirFor(prNumber);
  if (!existsSync(dir)) return false;
  await takeDownPreviewApp(dir);
  await reservations().releaseSlots(dir);
  await removeWorktreeDir(dir, 'stopPreview');
  log.info(`preview PR #${prNumber}: bajada y worktree borrado`);
  return true;
}

// A preview lives as long as its PR: once it's merged or closed, its app,
// its tailnet ports and its worktree go. Runs every tick, and a merge starts
// an event handler that runs it (pull_request closed — see
// server/api/webhooks/events.ts), so it goes right after.
// Costs nothing when there are no previews: the PR list is only read if
// there's a preview worktree on disk. A preview whose worker is still running
// waits for the next tick.
//
// A preview stays on the commit it was asked for: once its PR has newer
// ones (ronin applying a requested change, or anyone's push), the PR is
// told — once per preview — that `/preview` again brings it up to date.
//
// Nor does it hold a stack forever on an open PR: PREVIEW_TTL_MINUTES after
// it came up it goes, and the PR is told `/preview` brings it back.
// The active repo's previews that are up, as their state files say — for
// the dashboard (#65). Whether each one still answers isn't checked here.
export async function listPreviewStates(): Promise<PreviewState[]> {
  let entries: string[];
  try {
    entries = await readdir(activeRepo().worktreeBasePath);
  } catch {
    return [];
  }
  const states: PreviewState[] = [];
  for (const name of entries) {
    const pr = previewPrFromDirName(name);
    if (pr === null) continue;
    const state = await readPreviewState(previewDirFor(pr));
    if (!state) continue;
    // A worker that died mid-preparation never cleared it: nothing is
    // preparing anymore.
    if (state.preparing && !(await previewWorkerBusy(pr))) delete state.preparing;
    states.push(state);
  }
  return states;
}

export async function sweepPreviews(now: Date = new Date()): Promise<void> {
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
  const heads = new Map((await listOpenPrHeads()).map((p) => [p.number, p.headRefOid]));
  for (const pr of previews) {
    if (await previewWorkerBusy(pr)) continue;
    const head = heads.get(pr);
    if (head === undefined) {
      log.info(`preview PR #${pr}: el PR ya no está abierto, bajando su preview`);
      await stopPreview(pr);
    } else if (!(await expireIfDue(pr, now))) {
      await noticeIfStale(pr, head);
    }
  }
}

// True when it took the preview down.
async function expireIfDue(prNumber: number, now: Date): Promise<boolean> {
  const ttlMinutes = config.previewTtlMinutes;
  if (!(ttlMinutes > 0)) return false;
  const dir = previewDirFor(prNumber);
  const state = await readPreviewState(dir);
  if (!state) return false;
  const startedAt = state.startedAt ? Date.parse(state.startedAt) : NaN;
  if (Number.isNaN(startedAt)) {
    await writeFile(previewStatePath(dir), JSON.stringify({ ...state, startedAt: now.toISOString() }, null, 2));
    return false;
  }
  if (now.getTime() - startedAt < ttlMinutes * 60_000) return false;
  log.info(`preview PR #${prNumber}: pasaron ${ttlMinutes} min desde que se levantó, bajándola`);
  await stopPreview(prNumber);
  await commentOnSpecPr(prNumber, renderPreviewExpired(ttlMinutes, config.githubLogin))
    .catch((error) => log.error(`preview PR #${prNumber}: no se pudo avisar que venció`, error));
  return true;
}

async function noticeIfStale(prNumber: number, head: string): Promise<void> {
  const dir = previewDirFor(prNumber);
  const state = await readPreviewState(dir);
  if (!state || state.staleNotified || state.sha === head) return;
  try {
    await commentOnSpecPr(prNumber, renderPreviewStale(state.sha, config.githubLogin));
    await writeFile(previewStatePath(dir), JSON.stringify({ ...state, staleNotified: true }, null, 2));
    log.info(`preview PR #${prNumber}: quedó atrás de ${head.slice(0, 7)}, avisado en el PR`);
  } catch (error) {
    log.error(`preview PR #${prNumber}: no se pudo avisar que quedó desactualizada`, error);
  }
}

// --- replies ---

export function describeTtl(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hora' : `${minutes / 60} horas`;
  return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
}

export function renderPreviewExpired(ttlMinutes: number, login: string): string {
  return `⌛ Bajé la preview de este PR: llevaba ${describeTtl(ttlMinutes)} arriba. Pedí \`@${login} /preview\` para levantarla de nuevo.`;
}

export function renderPreviewStale(previewSha: string, login: string): string {
  return `🔄 La preview de este PR sigue en \`${previewSha.slice(0, 7)}\` y el PR ya tiene commits nuevos. Pedí \`@${login} /preview\` para actualizarla.`;
}

export function renderPreviewStarting(sha: string, withData: boolean): string {
  const data = withData ? ', y después preparo los datos para probar este PR' : '';
  return `⏳ Levantando la app con el código de \`${sha.slice(0, 7)}\` (dependencias, base y seeds${data}). Te aviso acá cuando esté.`;
}

function renderData(data: PreviewData | undefined): string[] {
  if (!data) return [];
  if ('error' in data) return [`⚠️ No pude preparar los datos para probar el PR (${data.error}): la app tiene solo los seeds base.`, ''];
  if (data.preparado.length === 0 && data.noPreparado.length === 0) {
    const base = data.base ?? [];
    return ['No hizo falta preparar datos: el PR se prueba con los seeds base.', ...(base.length > 0 ? ['', ...base.map((l) => `- ${l}`)] : []), ''];
  }
  return [
    ...(data.preparado.length > 0 ? ['**Datos listos para probar el PR**', ...data.preparado.map((l) => `- ${l}`), ''] : []),
    ...(data.noPreparado.length > 0 ? ['**Lo que no pude preparar**', ...data.noPreparado.map((l) => `- ${l}`), ''] : []),
  ];
}

export function renderPreviewReady(result: PreviewResult, login: string, ttlMinutes = 0): string {
  const lifetime = ttlMinutes > 0
    ? `Se baja sola en ${describeTtl(ttlMinutes)}, o antes si el PR se mergea o se cierra.`
    : 'Se baja sola cuando el PR se mergea o se cierra.';
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
    `${lifetime} Para bajarla antes: \`@${login} /preview stop\`. Con commits nuevos en el PR, volvé a pedir \`/preview\` para actualizarla; lo que escribas después del comando (\`/preview <qué preparar>\`) se suma a lo que piden los pasos de prueba.`,
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
