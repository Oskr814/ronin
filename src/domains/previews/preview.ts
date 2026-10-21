import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { appDown, appRerun, appUp, APP_STATE_DIR, stepLabel, type AppSession } from '../product-app/index.js';
import { APP_MANIFEST_FILE, appsTouched, parseAppManifest, publicizeTemplate, publicPortsIn, publicUrl, stepsToRerun, type AppDefinition, type AppStep, type AppUser, type TemplateContext } from '../product-app/index.js';
import { removeWorktreeDir } from '../../platform/git/worktree.js';
import { commentOnSpecPr, listOpenPrHeads, type PrHead } from '../../platform/github/github.js';
import { runAgentTask } from '../../platform/agents/agent-task.js';
import { previewTask, type PreviewTask } from './prompts.js';
import { parseSeedCatalog, readSeedCatalog, saveSeedCatalog, seedCatalogPath } from './seed-catalog.js';
import { HELP_FOOTER_MARKER } from '../commands/index.js';
import { config } from '../../platform/config/config.js';
import { launchWorker } from '../../platform/workers/worker-launch.js';
import { parsePortRange, PreviewReservations } from './reservations.js';
import { log } from '../../platform/logger.js';
import { previewRunGroup, withRunGroup } from '../../platform/agents/run-group.js';
import { worktreeLock } from '../../platform/workers/worktree-lock.js';
import { host } from '../../platform/host/host.js';


// `/preview [app]` on a PR: ronin brings the app up from the PR's head, with
// its seeds (and the base's ronin.app.json unless the PR changes it), in a worktree of its own, and publishes it on the tailnet with
// `tailscale serve` so whoever asked can try it from their own machine. It
// lives until the PR merges or closes (sweepPreviews, on the tick that
// event wakes up), until `/preview stop`, or until PREVIEW_TTL_MINUTES after
// it came up. See docs/DESIGN.md §12.

// `update` moves a preview that's up to its PR's new head (updatePreview):
// nobody asked for it in a comment, so it answers on the PR.
export type PreviewWorkerRequest =
  | {
      repo: string;
      prNumber: number;
      action: 'up' | 'stop';
      // What followed the command: an app and/or what the data should look
      // like — see resolvePreviewArgs.
      args?: string;
      // The /preview comment, to answer in its own place.
      comment: { id: number; kind: 'issue' | 'review' };
    }
  | { repo: string; prNumber: number; action: 'update' };

export function launchPreviewWorker(request: PreviewWorkerRequest): void {
  const pid = launchWorker('domains/previews/worker', request);
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
const lock = (prNumber: number) => worktreeLock(`preview-pr-${prNumber}`);

export function previewWorkerBusy(prNumber: number): Promise<boolean> {
  return lock(prNumber).busy();
}

export function acquirePreviewLock(prNumber: number): Promise<boolean> {
  return lock(prNumber).acquire();
}

export function releasePreviewLock(prNumber: number): Promise<void> {
  return lock(prNumber).release();
}

// --- tailscale ---

// The runner's MagicDNS name (e.g. <host>.<tailnet>.ts.net), the host every
// preview URL is served on.
export async function tailnetHost(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await host().exec('tailscale', ['status', '--json']));
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
  await host().exec('tailscale', ['serve', '--bg', `--https=${publicPort}`, `http://127.0.0.1:${localPort}`]);
}

async function unservePort(port: number): Promise<void> {
  await host().exec('tailscale', ['serve', `--https=${port}`, 'off'])
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
  // When it came up (ISO), what PREVIEW_TTL_MINUTES counts from. A state
  // from before the TTL has none: the sweep stamps it on first sight.
  startedAt?: string;
  // Up, but prepare-preview-data is still making the data the PR's test
  // steps need: the dashboard says so instead of offering a URL that would
  // be tried without them. Cleared once the data is done (or failed).
  preparing?: boolean;
  // What followed /preview, so a full rebuild during an update (see
  // updatePreview) prepares the same data again; and the part of it that
  // describes the data, for completing it on an update in place.
  args?: string;
  instruction?: string;
  // Moving to a new commit of the PR right now (updatePreview).
  updating?: boolean;
  // When it last moved to a new commit (ISO). startedAt doesn't change:
  // the TTL counts from the first boot.
  updatedAt?: string;
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

async function writePreviewState(dir: string, state: PreviewState): Promise<void> {
  await writeFile(previewStatePath(dir), JSON.stringify(state, null, 2));
}

// The ronin.app.json the preview was brought up with, as text: an update
// can only run steps again if the manifest is still the same one.
function previewManifestPath(dir: string): string {
  return join(dir, APP_STATE_DIR, 'preview-manifest.json');
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
  await host().exec('git', ['fetch', 'origin', pr.baseRefName], { cwd: repo });
  const baseRef = `origin/${pr.baseRefName}`;
  const mergeBase = (await host().exec('git', ['merge-base', baseRef, pr.headRefOid], { cwd: dir })).stdout.trim();
  // Exit code 1 means there's a difference.
  const changedByPr = await host().exec('git', ['diff', '--quiet', mergeBase, pr.headRefOid, '--', APP_MANIFEST_FILE], { cwd: dir })
    .then(() => false, () => true);
  const base = await host().exec('git', ['show', `${baseRef}:${APP_MANIFEST_FILE}`], { cwd: dir, maxBuffer: 10 * 1024 * 1024 })
    .then(({ stdout }) => stdout, () => null);
  const head = await readFile(join(dir, APP_MANIFEST_FILE), 'utf8').catch(() => null);
  const chosen = chooseManifest(changedByPr, base, head);
  if (!chosen) throw new Error(`ni este PR ni \`${pr.baseRefName}\` tienen un ${APP_MANIFEST_FILE}: no sé cómo levantar la app`);
  log.info(`preview: ${APP_MANIFEST_FILE} ${chosen.from === 'pr' ? 'del PR' : `de ${pr.baseRefName}`}`);
  return chosen.raw;
}

// What the PR changes against its base (previewManifest already fetched it),
// to tell which app it's about. Nothing when it can't be compared: then the
// app has to be named.
async function prFiles(dir: string, pr: Pick<PrHead, 'baseRefName' | 'headRefOid'>): Promise<string[]> {
  try {
    const mergeBase = (await host().exec('git', ['merge-base', `origin/${pr.baseRefName}`, pr.headRefOid], { cwd: dir })).stdout.trim();
    return await changedFiles(dir, mergeBase, pr.headRefOid);
  } catch {
    return [];
  }
}

// `/preview backoffice un cliente con 40 catálogos`, `/preview un cliente
// con 40 catálogos` and `/preview` all work: the first word is the app only
// when the manifest has an app by that name; otherwise it's the manifest's
// only app, or the only one the PR touches (`touched`), and everything is the
// instruction for the data.
export function resolvePreviewArgs(args: string | undefined, appNames: string[], touched: string[] = []): { appName: string; instruction?: string } {
  const text = (args ?? '').trim();
  const first = text.split(/\s+/)[0];
  const named = appNames.find((name) => name.toLowerCase() === first.toLowerCase());
  if (named) {
    const instruction = text.slice(first.length).trim();
    return instruction ? { appName: named, instruction } : { appName: named };
  }
  const only = appNames.length === 1 ? appNames[0] : touched.length === 1 ? touched[0] : null;
  if (!only) {
    const which = touched.length > 1 ? `y este PR toca ${touched.join(' y ')}` : 'y este PR no toca la carpeta de ninguna';
    throw new Error(`hay varias apps en ${APP_MANIFEST_FILE} (${appNames.join(', ')}) ${which}: pedí \`/preview <app>\``);
  }
  return text ? { appName: only, instruction: text } : { appName: only };
}

function isLiveWorktree(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return Promise.resolve(false);
  return host().exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    .then(({ stdout }) => stdout.trim() === 'true', () => false);
}

// Detached at the PR's head SHA, fetched through refs/pull/<n>/head like an
// external review's worktree. A live one is reused (its node_modules make a
// second /preview much faster) and moved to the new head.
async function ensurePreviewWorktree(prNumber: number, sha: string): Promise<string> {
  const dir = previewDirFor(prNumber);
  const repo = activeRepo().productRepoPath;
  await host().exec('git', ['fetch', 'origin', `pull/${prNumber}/head`], { cwd: repo });
  if (await isLiveWorktree(dir)) {
    await host().exec('git', ['checkout', '--detach', '--force', sha], { cwd: dir });
  } else {
    if (existsSync(dir)) await removeWorktreeDir(dir, 'ensurePreviewWorktree');
    await mkdir(activeRepo().worktreeBasePath, { recursive: true });
    await host().exec('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repo });
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
  await rm(previewManifestPath(dir), { force: true });
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

// What preview-data-delta answers: whether the new commits need more data.
export function parseDataDecision(raw: string): { completar: boolean; motivo: string } {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`la respuesta no tiene JSON: ${raw.trim().slice(0, 120)}`);
  const parsed = JSON.parse(json) as { completar?: unknown; motivo?: unknown };
  if (typeof parsed.completar !== 'boolean') throw new Error(`la respuesta no dice si completar: ${json.slice(0, 120)}`);
  return { completar: parsed.completar, motivo: typeof parsed.motivo === 'string' ? parsed.motivo.trim() : '' };
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
//
// `since`: the preview already had data and moved to newer commits — the
// agent gets only their diff and what was there, adds what they need, and
// writes to a file of its own so the earlier one stays until it's merged
// (see completeData).
async function prepareData(opts: {
  prNumber: number;
  pr: Pick<PrHead, 'title' | 'body' | 'baseRefName' | 'headRefOid'>;
  session: AppSession;
  instruction?: string;
  since?: { from: string; previous: { preparado: string[]; noPreparado: string[] } };
}): Promise<PreviewData> {
  const { prNumber, pr, session, since } = opts;
  const dir = session.dir;
  const outputPath = join(session.stateDir, since ? 'preview-data-delta.json' : 'preview-data.json');
  try {
    await rm(outputPath, { force: true });
    let mergeBase: string;
    if (since) {
      mergeBase = since.from;
    } else {
      await host().exec('git', ['fetch', 'origin', pr.baseRefName], { cwd: activeRepo().productRepoPath });
      mergeBase = (await host().exec('git', ['merge-base', `origin/${pr.baseRefName}`, pr.headRefOid], { cwd: dir })).stdout.trim();
    }
    const stat = (await host().exec('git', ['diff', '--stat', mergeBase, pr.headRefOid], { cwd: dir })).stdout.trim();
    const about = {
      prNumber,
      checkoutDir: dir,
      title: pr.title,
      // The cheat sheet ronin appends to its own PRs says nothing about the data.
      body: pr.body.split(HELP_FOOTER_MARKER)[0],
      ...(opts.instruction ? { instruction: opts.instruction } : {}),
      diff: { mergeBase, stat },
    };
    // On an update the database is no longer the base seed's, and the delta
    // already decided the data needs completing.
    const catalog = since ? null : await seedCatalog(prNumber, pr.headRefOid, session);
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
      ...(since ? { previous: since.previous } : {}),
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
    await host().exec('git', ['checkout', '--force', '--detach', pr.headRefOid], { cwd: dir })
      .then(() => host().exec('git', ['clean', '-fd'], { cwd: dir }))
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

// `startedAt`: when the preview first came up, for a rebuild that an update
// fell back to — the TTL keeps counting from there.
export async function startPreview(prNumber: number, pr: PrHead, args?: string, opts: { startedAt?: string } = {}): Promise<PreviewResult> {
  const host = await tailnetHost();
  const sha = pr.headRefOid;
  const existing = previewDirFor(prNumber);
  if (existsSync(existing)) await takeDownPreviewApp(existing);
  const dir = await ensurePreviewWorktree(prNumber, sha);
  const manifest = await previewManifest(dir, pr);
  const { apps } = parseAppManifest(manifest);
  const touched = Object.keys(apps).length > 1 ? appsTouched(apps, await prFiles(dir, pr)) : [];
  const { appName, instruction } = resolvePreviewArgs(args, Object.keys(apps), touched);
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
    const state: PreviewState = {
      prNumber,
      appName,
      sha,
      url,
      published,
      startedAt: opts.startedAt ?? new Date().toISOString(),
      ...(args?.trim() ? { args: args.trim() } : {}),
      ...(instruction ? { instruction } : {}),
      ...(config.previewPrepareData ? { preparing: true } : {}),
    };
    await writePreviewState(dir, state);
    await writeFile(previewManifestPath(dir), manifest);
    for (const p of published) await servePort(p.public, p.local);
    log.info(`preview PR #${prNumber}: ${appName} arriba en ${url}`);
    result = { appName, sha, url, users: session.app.users };
  } catch (error) {
    await takeDownPreviewApp(dir);
    await reservations().releaseSlots(dir);
    throw error;
  }
  if (!config.previewPrepareData) return result;
  // Its agents are one run on the dashboard: the preview (run-group.ts).
  const data = await withRunGroup(previewRunGroup(prNumber), () => prepareData({ prNumber, pr, session, ...(instruction ? { instruction } : {}) }));
  await markPrepared(dir);
  return { ...result, data };
}

// After an in-place update, on top of the data an earlier run left: a cheap
// model reads the new commits and decides whether they change what has to
// be tried (preview-data-delta), and only then prepare-preview-data adds
// what they need, on their diff alone. Nothing when the earlier
// preparation left nothing to build on (it failed, or never ran) — a
// /preview brings everything back. Never fails the update.
async function completeData(opts: {
  prNumber: number;
  pr: Pick<PrHead, 'title' | 'body' | 'baseRefName' | 'headRefOid'>;
  session: AppSession;
  from: string;
  instruction?: string;
}): Promise<{ data: PreviewData } | { kept: string } | null> {
  const { prNumber, pr, session, from, instruction } = opts;
  const dataPath = join(session.stateDir, 'preview-data.json');
  const previous = await readFile(dataPath, 'utf8').then(parsePreviewData, () => null);
  if (!previous) return null;
  let decision: { completar: boolean; motivo: string };
  try {
    const stat = (await host().exec('git', ['diff', '--stat', from, pr.headRefOid], { cwd: session.dir })).stdout.trim();
    decision = parseDataDecision(await runAgentTask(previewTask({
      type: 'preview-data-delta',
      prNumber,
      checkoutDir: session.dir,
      title: pr.title,
      body: pr.body.split(HELP_FOOTER_MARKER)[0],
      ...(instruction ? { instruction } : {}),
      diff: { from, stat },
      previous,
    })));
  } catch (error) {
    log.error(`preview PR #${prNumber}: no se pudo decidir si los commits nuevos necesitan más datos, quedan los que había`, error);
    return null;
  }
  log.info(`preview PR #${prNumber}: ${decision.completar ? 'completando los datos' : 'los datos siguen sirviendo'} (${decision.motivo})`);
  if (!decision.completar) return { kept: decision.motivo };
  const state = await readPreviewState(session.dir);
  if (state) await writePreviewState(session.dir, { ...state, preparing: true });
  const data = await prepareData({ prNumber, pr, session, since: { from, previous }, ...(instruction ? { instruction } : {}) });
  // What the next update builds on: everything left ready so far, and what
  // is still missing as of now.
  if (!('error' in data)) {
    await writeFile(dataPath, JSON.stringify({ preparado: [...previous.preparado, ...data.preparado], noPreparado: data.noPreparado }, null, 2))
      .catch((error) => log.error(`preview PR #${prNumber}: no se pudieron guardar los datos completados`, error));
  }
  await markPrepared(session.dir);
  return { data };
}

async function markPrepared(dir: string): Promise<void> {
  const state = await readPreviewState(dir);
  if (!state?.preparing) return;
  delete state.preparing;
  await writeFile(previewStatePath(dir), JSON.stringify(state, null, 2)).catch((error) => log.error('preview: no se pudo marcar los datos como listos', error));
}

// --- moving to a new commit ---

export type PreviewUpdate =
  // Already on the PR's head: nothing to do.
  | { kind: 'current' }
  // Same app, same stack, ports and data; `rerun` names the manifest steps
  // that ran again (none when the dev servers took the change on their own).
  // `data`: what was added for the new commits; `dataKept`: why what was
  // there still covers them (see completeData).
  | { kind: 'in-place'; from: string; sha: string; url: string; rerun: string[]; data?: PreviewData; dataKept?: string }
  // Brought up from scratch, like /preview, because of `reason`.
  | { kind: 'rebuilt'; from: string; reason: string; result: PreviewResult };

// The files that changed between two commits, as repo paths. A force-push
// still diffs fine as long as the old commit is still in the repo: it was
// the preview's own checkout.
async function changedFiles(dir: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await host().exec('git', ['diff', '--name-only', from, to], { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean);
}

// Moves the checkout to the PR's head and works out which steps have to
// run again on the app that's up, or why it can't be done in place: the
// manifest the preview would use now isn't the one it came up with (the
// PR's or its base's, §12), a compose file of the app changed (appUp
// rendered it once, at boot), or no step of the app declares `rerunOn`
// (see domains/product-app/manifest.ts's stepsToRerun).
export async function planInPlaceUpdate(
  prNumber: number,
  state: Pick<PreviewState, 'sha' | 'appName'>,
  pr: Pick<PrHead, 'baseRefName' | 'headRefOid'>,
): Promise<{ app: AppDefinition; steps: AppStep[] } | { reason: string }> {
  const dir = previewDirFor(prNumber);
  await host().exec('git', ['fetch', 'origin', `pull/${prNumber}/head`], { cwd: activeRepo().productRepoPath });
  let changed: string[];
  try {
    changed = await changedFiles(dir, state.sha, pr.headRefOid);
  } catch {
    return { reason: `no pude comparar \`${state.sha.slice(0, 7)}\` con \`${pr.headRefOid.slice(0, 7)}\`` };
  }
  await host().exec('git', ['checkout', '--detach', '--force', pr.headRefOid], { cwd: dir });
  const manifest = await previewManifest(dir, pr);
  const used = await readFile(previewManifestPath(dir), 'utf8').catch(() => null);
  if (used === null) return { reason: `no sé con qué ${APP_MANIFEST_FILE} se levantó` };
  if (manifest !== used) return { reason: `cambió el ${APP_MANIFEST_FILE}` };
  const app = parseAppManifest(manifest).apps[state.appName];
  if (!app) return { reason: `el ${APP_MANIFEST_FILE} ya no define la app "${state.appName}"` };
  if (app.compose?.files.some((file) => changed.includes(normalize(file)))) return { reason: 'cambió el compose de la app' };
  const steps = stepsToRerun(app, changed);
  if (!steps) return { reason: `ningún paso del ${APP_MANIFEST_FILE} dice cuándo volver a correr (\`rerunOn\`)` };
  return { app, steps };
}

// A new commit on a PR whose preview is up (pull_request.synchronize, or
// the sweep noticing it): the preview moves to it in place when it can —
// the dev servers recompile on their own, and only the steps the change
// touches run again — and is brought up from scratch otherwise, or when a
// step fails. Null when the PR has no preview up.
export async function updatePreview(prNumber: number, pr: PrHead): Promise<PreviewUpdate | null> {
  const dir = previewDirFor(prNumber);
  const state = await readPreviewState(dir);
  if (!state) return null;
  const from = state.sha;
  if (from === pr.headRefOid) return { kind: 'current' };
  await writePreviewState(dir, { ...state, updating: true });
  const rebuild = async (reason: string): Promise<PreviewUpdate> => {
    log.info(`preview PR #${prNumber}: reconstruyéndola de cero en ${pr.headRefOid.slice(0, 7)} (${reason})`);
    const result = await startPreview(prNumber, pr, state.args, state.startedAt ? { startedAt: state.startedAt } : {});
    return { kind: 'rebuilt', from, reason, result };
  };
  let plan: Awaited<ReturnType<typeof planInPlaceUpdate>>;
  try {
    plan = await planInPlaceUpdate(prNumber, state, pr);
  } catch (error) {
    return rebuild((error as Error).message.split('\n')[0].slice(0, 200));
  }
  if ('reason' in plan) return rebuild(plan.reason);
  let session: AppSession;
  try {
    session = await appRerun(dir, plan.app, plan.steps);
  } catch (error) {
    log.error(`preview PR #${prNumber}: la actualización en el lugar falló`, error);
    return rebuild((error as Error).message.split('\n')[0].slice(0, 200));
  }
  const { updating: _, ...rest } = (await readPreviewState(dir)) ?? state;
  await writePreviewState(dir, { ...rest, sha: pr.headRefOid, updatedAt: new Date().toISOString() });
  log.info(`preview PR #${prNumber}: actualizada en el lugar a ${pr.headRefOid.slice(0, 7)}`);
  const update: PreviewUpdate = { kind: 'in-place', from, sha: pr.headRefOid, url: state.url, rerun: plan.steps.map(stepLabel) };
  if (!config.previewPrepareData) return update;
  const completed = await withRunGroup(previewRunGroup(prNumber), () => completeData({ prNumber, pr, session, from, ...(state.instruction ? { instruction: state.instruction } : {}) }));
  if (!completed) return update;
  return 'data' in completed ? { ...update, data: completed.data } : { ...update, dataKept: completed.kept };
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
// apps/api/webhooks/events.ts), so it goes right after.
// Costs nothing when there are no previews: the PR list is only read if
// there's a preview worktree on disk. A preview whose worker is still running
// waits for the next tick.
//
// A preview follows its PR: a new commit (ronin applying a requested
// change, or anyone's push) launches its update — see updatePreview. The
// pull_request.synchronize event does it right away
// (launchPreviewUpdates); the sweep catches whatever that missed.
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
    // A worker that died mid-preparation (or mid-update) never cleared it:
    // nothing is preparing anymore.
    if ((state.preparing || state.updating) && !(await previewWorkerBusy(pr))) {
      delete state.preparing;
      delete state.updating;
    }
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
      const state = await readPreviewState(previewDirFor(pr));
      if (state && state.sha !== head) {
        log.info(`preview PR #${pr}: quedó atrás de ${head.slice(0, 7)}, actualizándola`);
        launchUpdate(pr);
      }
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

function launchUpdate(prNumber: number): void {
  try {
    launchPreviewWorker({ repo: activeRepo().productRepo, prNumber, action: 'update' });
  } catch (error) {
    log.error(`preview PR #${prNumber}: no se pudo lanzar la actualización`, error);
  }
}

// New commits on `prs` (pull_request.synchronize — see
// apps/api/webhooks/handler.ts): each one with a preview up gets its
// update. The worker compares the SHA itself, so this reads nothing from
// GitHub. One whose worker is busy is skipped: an update reads the PR's
// head again before it ends, and a /preview still coming up is left to the
// sweep.
export async function launchPreviewUpdates(prs: number[]): Promise<void> {
  for (const pr of prs) {
    if (!(await readPreviewState(previewDirFor(pr))) || (await previewWorkerBusy(pr))) continue;
    log.info(`preview PR #${pr}: commit nuevo, actualizándola`);
    launchUpdate(pr);
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
    `${lifetime} Para bajarla antes: \`@${login} /preview stop\`. Con cada commit nuevo del PR se actualiza sola; \`/preview\` otra vez la levanta de cero. Lo que escribas después del comando (\`/preview <qué preparar>\`) se suma a lo que piden los pasos de prueba.`,
  ].join('\n');
}

export function renderPreviewUpdated(update: Exclude<PreviewUpdate, { kind: 'current' }>): string {
  const commits = `\`${update.from.slice(0, 7)}\` → \`${(update.kind === 'in-place' ? update.sha : update.result.sha).slice(0, 7)}\``;
  if (update.kind === 'rebuilt') {
    return [
      `🔄 Actualicé la preview de este PR (${commits}) levantándola de cero, porque ${update.reason}: **${update.result.url}**`,
      '',
      ...renderData(update.result.data),
    ].join('\n').trim();
  }
  const rerun = update.rerun.length > 0
    ? `Volví a correr: ${update.rerun.map((s) => `*${s}*`).join(', ')}.`
    : 'No hizo falta volver a correr ningún paso: los dev servers tomaron el cambio solos.';
  return [
    `🔄 Actualicé la preview de este PR (${commits}), en la misma URL y con los mismos datos. ${rerun}`,
    ...(update.dataKept ? ['', `Los datos que ya había siguen sirviendo: ${update.dataKept}`] : []),
    ...(update.data ? ['', ...renderData(update.data)] : []),
  ].join('\n').trim();
}

export function renderPreviewUpdateFailed(error: Error): string {
  return renderPreviewFailed(error).replace('❌ No pude levantar la app:', '❌ No pude actualizar la preview con el commit nuevo, y quedó abajo:');
}

export function renderPreviewFailed(error: Error): string {
  const [first, ...rest] = error.message.split('\n');
  const detail = rest.join('\n').trim();
  return [
    `❌ No pude levantar la app: ${first.slice(0, 300)}`,
    ...(detail ? ['', '<details><summary>Últimas líneas del log</summary>', '', '```', detail.slice(-3000), '```', '</details>'] : []),
  ].join('\n');
}
