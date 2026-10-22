import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { host } from '@platform/host/host.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { config } from '@platform/config/config.js';
import { getFreePort } from '@platform/git/worktree.js';
import { log } from '@platform/logger.js';
import { ActionRefused } from '@platform/actions/catalog.js';
import type { RunApp, RunServices } from '@platform/actions/executors.js';
import type { AgentUser } from '@platform/agents/agent-user.js';
import { APP_MANIFEST_FILE } from './manifest.js';
import { appCompose, appEnv, rewriteComposeConfig } from './runtime.js';

// The services an agent's tests need, for a run that has no Docker of its
// own (#257, the services.* actions): ronin runs the repo's compose — the
// one in ronin.app.json, taken from the base branch, never the run's
// checkout, which the agent can edit — with its published ports moved to
// free ones on localhost, and the repo's bind mounts pointed at the run's
// checkout. A project of its own per run, taken down when the run ends.

const UP_TIMEOUT_MS = 10 * 60_000;
// Under the 10 minutes a Bash call of the agent can last at most.
const RUN_TIMEOUT_MS = 9 * 60_000;
const OUTPUT_MAX = 8_000;

// A bind mount of the base checkout (the repo, or a folder of it) points
// at the run's checkout instead: what a test runs on is the agent's code.
// Paths come absolute out of `docker compose config`.
export function mountCheckout(resolved: any, baseDir: string, checkoutDir: string): any {
  const moved = (source: string) =>
    source === baseDir ? checkoutDir : source.startsWith(`${baseDir}/`) ? `${checkoutDir}${source.slice(baseDir.length)}` : source;
  const services: Record<string, any> = {};
  for (const [name, service] of Object.entries<any>(resolved.services ?? {})) {
    services[name] = Array.isArray(service.volumes)
      ? { ...service, volumes: service.volumes.map((v: any) => (v?.type === 'bind' && typeof v.source === 'string' ? { ...v, source: moved(v.source) } : v)) }
      : service;
  }
  return { ...resolved, services };
}

// Every compose file the manifest's apps name, without validating the rest
// of it: the services don't need the app's steps, users or URLs.
export function composeFilesOf(manifest: string): string[] {
  let apps: unknown;
  try {
    apps = (JSON.parse(manifest) as { apps?: unknown }).apps;
  } catch {
    throw new ActionRefused(`el ${APP_MANIFEST_FILE} de la rama base no es JSON válido`);
  }
  const files = Object.values(apps && typeof apps === 'object' ? apps : {})
    .flatMap((app: any) => (Array.isArray(app?.compose?.files) ? app.compose.files : []))
    .filter((f: unknown): f is string => typeof f === 'string');
  return [...new Set(files)];
}

// A command in a container, `docker <args> sh -c <command>`: its exit code
// and the end of what it printed.
async function inContainer(args: string[], command: string, opts: { cwd: string; checkoutDir: string; owner: AgentUser | null }): Promise<{ exitCode: number; output: string }> {
  let exitCode = 0;
  let output: string;
  try {
    // The command's stderr into its stdout, in order (`exec 2>&1`): what
    // comes back is what it printed. Compose's own progress goes to
    // docker's stderr, kept only when the command didn't run.
    const done = await host().exec('docker', [...args, 'sh', '-c', `exec 2>&1; ${command}`], {
      cwd: opts.cwd, env: appEnv(), timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    });
    output = done.stdout;
  } catch (error) {
    const e = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    output = e.stdout || (e.stderr ?? '').slice(-2_000);
    if (e.killed) output += `\n(cortado a los ${RUN_TIMEOUT_MS / 60_000} minutos)`;
  } finally {
    // What the container wrote in the checkout is root's: back to the
    // agent, or it can't change or delete it.
    if (opts.owner) await host().exec('chown', ['-R', `${opts.owner.uid}:${opts.owner.gid}`, opts.checkoutDir]).catch(() => {});
  }
  return { exitCode, output: output.length > OUTPUT_MAX ? `…${output.slice(-OUTPUT_MAX)}` : output };
}

// The stack of the app a task brought up for its run (#257, app.exec), as
// appUp left it in `dir`: a command in the container of one of its
// services, or in a new one (`oneOff`, `compose run --rm`). `owner`: the
// agent's user, when `dir` is its checkout.
export function appStack(dir: string, owner: AgentUser | null): RunApp {
  return {
    async exec(service, command, oneOff) {
      const stack = await appCompose(dir);
      if (!stack) throw new ActionRefused('la app de esta corrida no tiene un stack de compose');
      if (!stack.services.includes(service)) throw new ActionRefused(`el compose de la app no tiene ${service}; tiene: ${stack.services.join(', ')}`);
      return inContainer([...stack.args, ...(oneOff ? ['run', '--rm', '-T'] : ['exec', '-T']), service], command, { cwd: dir, checkoutDir: dir, owner });
    },
  };
}

interface Stack {
  file: string;
  ports: Record<string, Record<string, number>>;
  names: string[];
}

export function runServices(opts: { checkoutDir: string; owner: AgentUser | null }): RunServices {
  const repo = activeRepo();
  const id = randomBytes(4).toString('hex');
  const project = `ronin-svc-${id}`;
  const baseDir = join(repo.worktreeBasePath, `services-${id}`);
  const baseRef = repo.worktreeBaseRef ?? config.worktreeBaseRef;
  let stack: Promise<Stack> | null = null;

  const prepare = async (): Promise<Stack> => {
    await host().exec('git', ['fetch', 'origin'], { cwd: repo.productRepoPath });
    await host().exec('git', ['worktree', 'add', '--detach', baseDir, baseRef], { cwd: repo.productRepoPath });
    const raw = await host().fs.readFile(join(baseDir, APP_MANIFEST_FILE), 'utf8').catch(() => null);
    if (!raw) throw new ActionRefused(`la rama base no tiene ${APP_MANIFEST_FILE}: no hay servicios que levantar`);
    const files = composeFilesOf(raw);
    if (files.length === 0) throw new ActionRefused(`el ${APP_MANIFEST_FILE} de la rama base no nombra ningún compose`);
    const { stdout } = await host().exec('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], {
      cwd: baseDir, env: appEnv(), maxBuffer: 16 * 1024 * 1024,
    });
    const { config: rewritten, ports } = await rewriteComposeConfig(JSON.parse(stdout), getFreePort);
    const file = join(baseDir, '.ronin-services.json');
    await host().fs.writeFile(file, JSON.stringify(mountCheckout(rewritten, baseDir, opts.checkoutDir), null, 2));
    return { file, ports, names: Object.keys(rewritten.services ?? {}) };
  };
  const ready = async (wanted: string[]): Promise<Stack> => {
    stack ??= prepare();
    const s = await stack;
    const unknown = wanted.filter((name) => !s.names.includes(name));
    if (unknown.length > 0) throw new ActionRefused(`el compose no tiene ${unknown.join(', ')}; tiene: ${s.names.join(', ')}`);
    return s;
  };
  const compose = (s: Stack) => ['compose', '-p', project, '-f', s.file];

  return {
    async up(services) {
      const s = await ready(services);
      await host().exec('docker', [...compose(s), 'up', '-d', '--wait', ...services], { cwd: baseDir, env: appEnv(), timeout: UP_TIMEOUT_MS });
      return Object.fromEntries(services.map((name) => [name, s.ports[name] ?? {}]));
    },

    async run(service, command) {
      const s = await ready([service]);
      return inContainer([...compose(s), 'run', '--rm', '-T', service], command, { cwd: baseDir, checkoutDir: opts.checkoutDir, owner: opts.owner });
    },

    async close() {
      if (!stack) return;
      const s = await stack.catch(() => null);
      if (s) {
        await host().exec('docker', [...compose(s), 'down', '--volumes', '--remove-orphans'], { cwd: baseDir, env: appEnv() })
          .catch((error) => log.error(`servicios ${project}: 'docker compose down' falló`, error));
      }
      await host().exec('git', ['worktree', 'remove', '--force', baseDir], { cwd: repo.productRepoPath })
        .catch((error) => log.error(`servicios ${project}: no se pudo quitar ${baseDir}`, error));
    },
  };
}
