import { basename, dirname, join } from 'node:path';
import { activeRepo } from '@platform/agents/repo-context.js';
import { config } from '@platform/config/config.js';
import { getFreePort } from '@platform/git/worktree.js';
import { log } from '@platform/logger.js';
import { loadAppDefinition, namedPortsIn, publicizeTemplate, publicPortsIn, renderTemplate, usesCompose, type AppDefinition, type AppStep, type TemplateContext } from './manifest.js';
import { AGENT_ENV_KEYS } from '@platform/claude/claude-runner.js';
import { confineCompose, stackCommand } from './confine.js';
import type { AgentUser } from '@platform/agents/agent-user.js';
import { host } from '@platform/host/host.js';
import { APP_PROCESS_ENV } from '@platform/workers/process.js';


// Brings an app of the product repo up in a checkout, from its
// ronin.app.json — see docs/DESIGN.md §11.2. Everything it starts is
// recorded in <checkout>/.ronin-app/state.json, so appDown can stop it even
// from another process (the CLI's `app down`, or a later tick).
//
// An app that runs from a checkout of the agent's, which the agent edits
// while it runs (#257, AppUpOptions.as), keeps it next to the checkout
// instead, in a directory of root's: the state says which processes ronin
// stops and which compose file it runs, and the agent must not write it.
export const APP_STATE_DIR = '.ronin-app';

interface AppState {
  appName: string;
  project: string;
  composeFile?: string;
  processes: Array<{ name: string; pid: number }>;
  // The agent's user its code runs as (AppUpOptions.as).
  as?: AgentUser;
  // Set once the app is fully up — what attachApp needs to hand a running
  // app to another process.
  baseUrl?: string;
  ctx?: TemplateContext;
}

export interface AppSession {
  appName: string;
  app: AppDefinition;
  dir: string;
  baseUrl: string;
  ctx: TemplateContext;
  stateDir: string;
}

// The env the app's own commands run with: ronin's, minus its secrets — a dev
// server has no business seeing the GitHub token or the mail password.
// NODE_ENV goes too: it's ronin's own (the image sets it to production), and
// under it `pnpm install` skips the devDependencies a dev server needs.
const RONIN_ONLY_ENV = ['RONIN_GITHUB_TOKEN', 'GH_TOKEN', 'GMAIL_APP_PASSWORD', 'WEBHOOK_SECRET', 'NODE_ENV'];

// CI=true, as nobody is there to answer: when a worktree's node_modules was
// installed another way (without its devDependencies, before NODE_ENV went),
// `pnpm install` asks before reinstalling it from scratch, and with no
// terminal it exits 0 having installed nothing — the dev server then isn't
// found. Under CI it reinstalls without asking. APP_PROCESS_ENV marks them as
// the app's, so the runner's drain doesn't wait on a dev server.
export function appEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', [APP_PROCESS_ENV]: '1' };
  for (const key of RONIN_ONLY_ENV) delete env[key];
  Object.assign(env, extra);
  return env;
}

// A compose project per app, not per run: the images it builds (the API's
// Dockerfile, for one) are tagged with the project name, so a stable name
// keeps them cached between runs. One instance of each app at a time, unless
// the caller names its own (a /preview runs one per PR, next to exploration).
export function appProjectName(appName: string, instance?: string): string {
  const slug = [activeRepo().productRepo, appName, instance].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `ronin-app-${slug}`;
}

export interface AppUpOptions {
  // Suffix for the compose project, so this instance runs next to the app's
  // default one.
  instance?: string;
  // Host the `{{public.…}}` templates render with — see domains/product-app/manifest.ts.
  publicHost?: string;
  // Gives the port a local one will be published on, when the caller
  // publishes in a range of its own; without it the public port is the
  // local one.
  publicPort?: (localPort: number) => Promise<number>;
  // The manifest's text, instead of the checkout's ronin.app.json.
  manifest?: string;
  // The checkout is the agent's (#257): what runs the app's code — its
  // installs, builds and dev servers — runs as that user, with nothing of
  // ronin's environment, and the app's state stays out of the checkout.
  as?: AgentUser;
}

// Takes `docker compose config --format json` (every path already absolute,
// every variable resolved) and makes it safe to run next to anything else on
// this host: a published port becomes a free one, and a fixed container_name
// goes away so the project name scopes it. shoppingcart's dev compose pins
// both ("web" on 5000, "postgres-ecommerce" on 5434), so a human's own stack
// would otherwise collide with ronin's. Returns the host port each
// service's container port ended up on.
export async function rewriteComposeConfig(
  resolved: any,
  freePort: () => Promise<number>,
): Promise<{ config: any; ports: Record<string, Record<string, number>> }> {
  const ports: Record<string, Record<string, number>> = {};
  const services: Record<string, any> = {};
  for (const [name, service] of Object.entries<any>(resolved.services ?? {})) {
    const { container_name: _, ...rest } = service;
    if (Array.isArray(service.ports)) {
      rest.ports = [];
      for (const port of service.ports) {
        const published = await freePort();
        rest.ports.push({ ...port, published: String(published), host_ip: '127.0.0.1' });
        (ports[name] ??= {})[String(port.target)] = published;
      }
    }
    services[name] = rest;
  }
  // `name` is replaced by the -p flag; dropping it keeps the file valid
  // whatever project it ends up running under.
  const { name: _name, ...rest } = resolved;
  return { config: { ...rest, services }, ports };
}

// Where an agent's checkout keeps its state: <worktrees>/.ronin-app/<name>,
// made by appUp before anything else, and gone only with the checkout
// (removeAppState) — so the agent never gets to plant a state of its own
// in the checkout for ronin to read instead.
function outsideStateDir(dir: string): string {
  return join(dirname(dir), APP_STATE_DIR, basename(dir));
}

async function stateDirOf(dir: string): Promise<string> {
  const outside = outsideStateDir(dir);
  return (await host().fs.exists(outside)) ? outside : join(dir, APP_STATE_DIR);
}

async function readState(dir: string): Promise<AppState | null> {
  try {
    return JSON.parse(await host().fs.readFile(join(await stateDirOf(dir), 'state.json'), 'utf8')) as AppState;
  } catch {
    return null;
  }
}

async function writeState(dir: string, state: AppState): Promise<void> {
  await host().fs.writeFile(join(await stateDirOf(dir), 'state.json'), JSON.stringify(state, null, 2));
}

// Once an agent's checkout is gone, its state goes too — never before: with
// the checkout still there, the next appDown would read the one inside it.
export async function removeAppState(dir: string): Promise<void> {
  await host().fs.rm(outsideStateDir(dir), { recursive: true, force: true });
}

// How a step runs: as ronin, with appEnv; or, for an agent's checkout, as
// the agent's user with an environment built from scratch. A step there
// that uses the stack ({{compose}}) needs ronin's Docker: it goes through
// stackStep instead.
function stepProcess(state: AppState, extra: Record<string, string>): { env: NodeJS.ProcessEnv; uid?: number; gid?: number } {
  if (!state.as) return { env: appEnv(extra) };
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { HOME: state.as.home, USER: state.as.name, LOGNAME: state.as.name, CI: 'true', [APP_PROCESS_ENV]: '1' }, extra);
  return { env, uid: state.as.uid, gid: state.as.gid };
}

const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

// A step of an agent's checkout that uses the stack, as ronin: only a
// command in one of its containers (confine.ts's stackCommand), each word
// quoted, so sh runs nothing but docker.
function stackStep(state: AppState, template: string, ctx: TemplateContext): string {
  return ['docker', ...composeArgs(state), ...stackCommand(template, ctx)].map(quote).join(' ');
}

function composeArgs(state: Pick<AppState, 'project' | 'composeFile'>): string[] {
  return ['compose', '-p', state.project, ...(state.composeFile ? ['-f', state.composeFile] : [])];
}

// Any answer below 500 counts as up: a 404 on "/" still means the server is
// listening, which is all a readiness check needs.
export async function waitForUrl(url: string, timeoutMs: number, intervalMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${url} no respondió en ${Math.round(timeoutMs / 1000)}s (último error: ${lastError})`);
}

// Everything a template needs before it can render: its named ports, and —
// when the caller publishes the app on ports of its own — the public port
// of every `{{public.…}}` it references.
async function reservePorts(templates: string[], ctx: TemplateContext, options: AppUpOptions): Promise<void> {
  for (const name of templates.flatMap(namedPortsIn)) {
    if (ctx.port[name] === undefined) ctx.port[name] = await getFreePort();
  }
  if (!options.publicPort) return;
  for (const local of templates.flatMap((t) => publicPortsIn(t, ctx))) {
    ctx.publicPorts ??= {};
    ctx.publicPorts[String(local)] ??= await options.publicPort(local);
  }
}

interface StepRun {
  appName: string;
  dir: string;
  state: AppState;
  ctx: TemplateContext;
  options: AppUpOptions;
  logFile: string;
}

// How a step is named in logs and in what a preview tells the PR.
export function stepLabel(step: AppStep): string {
  if ('compose' in step) return 'compose';
  if ('run' in step) return step.name ?? step.run;
  if ('start' in step) return step.name;
  return step.name ?? step.wait;
}

// One step of the manifest, on the app's stack and ports. A `start` whose
// process is already running (appRerun) stops it first, so the step
// restarts it.
async function runStep(step: AppStep, run: StepRun): Promise<void> {
  const { appName, dir, state, ctx, options, logFile } = run;
  if ('compose' in step) {
    log.info(`app ${appName}: docker compose up (${state.project})`);
    await host().runLogged(`docker ${composeArgs(state).join(' ')} up -d --build`, { cwd: dir, env: appEnv(), logFile, timeoutMs: 20 * 60_000 });
  } else if ('run' in step) {
    await reservePorts([step.run, ...Object.values(step.env ?? {})], ctx, options);
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, renderTemplate(v, ctx)]));
    log.info(`app ${appName}: ${stepLabel(step)}`);
    const timeoutMs = (step.timeoutSeconds ?? 600) * 1000;
    if (state.as && usesCompose(step.run)) await host().runLogged(stackStep(state, step.run, ctx), { cwd: dir, env: appEnv(env), logFile, timeoutMs });
    else await host().runLogged(renderTemplate(step.run, ctx), { cwd: join(dir, step.cwd ?? '.'), ...stepProcess(state, env), logFile, timeoutMs });
  } else if ('start' in step) {
    // A no-op without a public host: {{public.…}} renders the same
    // loopback URL — see publicizeTemplate.
    if (state.as && usesCompose(step.start)) throw new Error(`en un checkout del agente, un proceso que queda corriendo no usa el stack: "${step.start}"`);
    const envTemplates = Object.entries(step.env ?? {}).map(([k, v]) => [k, publicizeTemplate(v)] as const);
    await reservePorts([step.start, ...envTemplates.map(([, v]) => v)], ctx, options);
    const env = Object.fromEntries(envTemplates.map(([k, v]) => [k, renderTemplate(v, ctx)]));
    const running = state.processes.find((p) => p.name === step.name);
    if (running) {
      log.info(`app ${appName}: reiniciando ${step.name}`);
      await host().stopGroup(running.pid);
      state.processes = state.processes.filter((p) => p !== running);
    } else {
      log.info(`app ${appName}: arrancando ${step.name}`);
    }
    const pid = host().startLogged(renderTemplate(step.start, ctx), { cwd: join(dir, step.cwd ?? '.'), ...stepProcess(state, env), logFile: join(await stateDirOf(dir), `${step.name}.log`) });
    state.processes.push({ name: step.name, pid });
    await writeState(dir, state);
  } else {
    await reservePorts([step.wait], ctx, options);
    const url = renderTemplate(step.wait, ctx);
    log.info(`app ${appName}: esperando ${step.name ?? url}`);
    await waitForUrl(url, (step.timeoutSeconds ?? 300) * 1000);
  }
}

// Brings the app up in `dir` (any checkout of the product repo: an
// exploration worktree today, a slice's own worktree later). On failure it
// tears down whatever it already started before rethrowing.
export async function appUp(dir: string, appName: string, options: AppUpOptions = {}): Promise<AppSession> {
  const app = await loadAppDefinition(dir, appName, options.manifest);
  const stateDir = options.as ? outsideStateDir(dir) : join(dir, APP_STATE_DIR);
  await host().fs.mkdir(stateDir, { recursive: true, ...(options.as ? { mode: 0o700 } : {}) });
  // Never committed by accident: a task that runs `git add -A` in this
  // checkout must not pick up the app's logs and state. info/exclude is
  // shared by every worktree of the repo, which is what we want here. An
  // agent's checkout has neither (and ronin runs no git in it).
  if (!options.as) await excludeFromGit(dir);
  if (await readState(dir)) await appDown(dir);

  const state: AppState = { appName, project: appProjectName(appName, options.instance), processes: [], ...(options.as ? { as: options.as } : {}) };
  const ctx: TemplateContext = { ports: {}, port: {}, compose: '', dir, ...(options.publicHost ? { publicHost: options.publicHost } : {}) };
  const logFile = join(stateDir, 'up.log');
  await host().fs.writeFile(logFile, '');
  await writeState(dir, state);

  try {
    if (app.compose) {
      const args = ['compose', ...app.compose.files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'];
      const { stdout } = await host().exec('docker', args, { cwd: dir, env: appEnv(), maxBuffer: 16 * 1024 * 1024 });
      const resolved = JSON.parse(stdout);
      if (options.as) confineCompose(resolved, dir);
      const { config: rewritten, ports } = await rewriteComposeConfig(resolved, getFreePort);
      state.composeFile = join(stateDir, 'compose.json');
      await host().fs.writeFile(state.composeFile, JSON.stringify(rewritten, null, 2));
      await writeState(dir, state);
      ctx.ports = ports;
    }
    ctx.compose = ['docker', ...composeArgs(state)].join(' ');

    for (const step of app.steps) await runStep(step, { appName, dir, state, ctx, options, logFile });

    await reservePorts([app.baseUrl], ctx, options);
    const baseUrl = renderTemplate(app.baseUrl, ctx).replace(/\/$/, '');
    await waitForUrl(baseUrl, 120_000);
    await writeState(dir, { ...state, baseUrl, ctx });
    log.info(`app ${appName}: arriba en ${baseUrl}`);
    return { appName, app, dir, baseUrl, ctx, stateDir };
  } catch (error) {
    log.error(`app ${appName}: no levantó, bajando lo que alcanzó a arrancar`, error);
    await appDown(dir);
    throw error;
  }
}

// Runs `steps` of `app` again on the app appUp left running in `dir`, after
// its checkout moved to another commit: same compose stack, same ports, same
// data (see domains/product-app/manifest.ts's stepsToRerun for which steps). Then waits for
// the app to answer again. Unlike appUp, a failure tears nothing down —
// the caller decides (a preview brings the app up from scratch instead).
// The log of this run is <stateDir>/rerun.log.
export async function appRerun(dir: string, app: AppDefinition, steps: AppStep[]): Promise<AppSession> {
  const state = await readState(dir);
  if (!state?.baseUrl || !state.ctx) throw new Error(`no hay una app arriba en ${dir}`);
  const { ctx, baseUrl } = state;
  const logFile = join(await stateDirOf(dir), 'rerun.log');
  await host().fs.writeFile(logFile, '');
  for (const step of steps) {
    try {
      await runStep(step, { appName: state.appName, dir, state, ctx, options: {}, logFile });
    } catch (error) {
      throw new Error(`falló "${stepLabel(step)}": ${(error as Error).message}`);
    }
  }
  await waitForUrl(baseUrl, 120_000);
  await writeState(dir, state);
  log.info(`app ${state.appName}: actualizada en ${baseUrl} (${steps.length === 0 ? 'sin pasos' : steps.map(stepLabel).join(', ')})`);
  return { appName: state.appName, app, dir, baseUrl, ctx, stateDir: await stateDirOf(dir) };
}

// An app another process brought up with appUp and left running (the CLI's
// `app up`), or null if nothing is fully up in `dir`.
export async function attachApp(dir: string): Promise<AppSession | null> {
  const state = await readState(dir);
  if (!state?.baseUrl || !state.ctx) return null;
  const app = await loadAppDefinition(dir, state.appName);
  return { appName: state.appName, app, dir, baseUrl: state.baseUrl, ctx: state.ctx, stateDir: await stateDirOf(dir) };
}

// Stops every process appUp started and takes the compose stack down with
// its volumes. Never throws: like removeWorktree, a cleanup failure is
// logged, not allowed to mask the error that led here.
export async function appDown(dir: string): Promise<void> {
  const state = await readState(dir);
  if (!state) return;
  for (const p of state.processes) await host().stopGroup(p.pid);
  if (state.composeFile && (await host().fs.exists(state.composeFile))) {
    await host().exec('docker', [...composeArgs(state), 'down', '--volumes', '--remove-orphans'], { cwd: dir, env: appEnv() })
      .catch((error) => log.error(`appDown: 'docker compose down' falló para ${state.project}`, error));
  }
  await host().fs.rm(join(await stateDirOf(dir), 'state.json'), { force: true });
}

async function excludeFromGit(dir: string): Promise<void> {
  try {
    const { stdout } = await host().exec('git', ['rev-parse', '--git-common-dir'], { cwd: dir });
    const commonDir = stdout.trim();
    const excludeFile = join(commonDir.startsWith('/') ? commonDir : join(dir, commonDir), 'info', 'exclude');
    const current = await host().fs.readFile(excludeFile, 'utf8').catch(() => '');
    if (!current.split('\n').includes(`${APP_STATE_DIR}/`)) {
      await host().fs.mkdir(join(excludeFile, '..'), { recursive: true });
      await host().fs.appendFile(excludeFile, `${current.endsWith('\n') || current === '' ? '' : '\n'}${APP_STATE_DIR}/\n`);
    }
  } catch (error) {
    log.error(`no se pudo excluir ${APP_STATE_DIR}/ de git en ${dir}`, error);
  }
}

// The checkout an app runs from when nothing else provides one (the CLI,
// exploration): a detached worktree of the base branch, refreshed each time.
// Its directory name doesn't match sweepOrphanedWorktrees's ronin-<n>-…
// pattern, so the sweep never touches it.
export function appWorktreeDirFor(appName: string): string {
  return join(activeRepo().worktreeBasePath, `app-${appName}`);
}

export async function ensureAppWorktree(appName: string, ref = activeRepo().worktreeBaseRef ?? config.worktreeBaseRef): Promise<string> {
  const dir = appWorktreeDirFor(appName);
  const repo = activeRepo().productRepoPath;
  await host().exec('git', ['fetch', 'origin'], { cwd: repo });
  const isLive = (await host().fs.exists(dir)) &&
    (await host().exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir }).then(({ stdout }) => stdout.trim() === 'true', () => false));
  if (isLive) {
    await appDown(dir);
    await host().exec('git', ['checkout', '--detach', '--force', ref], { cwd: dir });
  } else {
    await host().fs.mkdir(activeRepo().worktreeBasePath, { recursive: true });
    await host().exec('git', ['worktree', 'add', '--detach', dir, ref], { cwd: repo });
  }
  return dir;
}
