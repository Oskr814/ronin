import { execFile, spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pidAlive } from '../workers/process.js';

// Where ronin runs what it does on the code (#235, stage 4): git and the
// worktrees, `docker compose`, the product's dev servers, tests and builds.
// Every domain asks host() instead of starting processes itself, so the
// day a job runs on another machine (a runner over SSH, see ARCHITECTURE.md's
// «Proyección») only a new Host is written. Today there is one: this
// machine's. ronin's own processes (its workers, `claude -p`) are not the
// host's: they always run on the central node.

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

export interface LoggedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Where its output goes, appended.
  logFile: string;
}

export interface Host {
  readonly name: string;
  // A command to its end: what it wrote. A command that fails rejects with
  // execFile's error, which carries its stdout, stderr and code.
  exec(file: string, args: readonly string[], opts?: ExecOptions): Promise<{ stdout: string; stderr: string }>;
  // The same, its output as bytes (a file out of git).
  execBuffer(file: string, args: readonly string[], opts?: ExecOptions): Promise<{ stdout: Buffer }>;
  // A shell command to its end, its output to the log; it fails with the
  // log's last lines when it exits with another code or runs past timeoutMs.
  runLogged(command: string, opts: LoggedOptions & { timeoutMs: number }): Promise<void>;
  // A shell command left running (a dev server) in its own process group,
  // its output to the log: its pid.
  startLogged(command: string, opts: LoggedOptions): number;
  alive(pid: number): boolean;
  // A port nothing listens on now, for a dev server or a compose service.
  freePort(): Promise<number>;
  // How claude -p starts the browser MCP (Playwright) that drives an app on
  // this host: its command, with the server's arguments.
  browserMcp(args: string[]): { command: string; args: string[] };
  // Stops a process group: SIGTERM, and SIGKILL to whatever is left after 5 s.
  stopGroup(pid: number): Promise<void>;
}

const execFileAsync = promisify(execFile);

async function tail(file: string, lines = 30): Promise<string> {
  try {
    return (await readFile(file, 'utf8')).split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export const localHost: Host = {
  name: 'local',

  async exec(file, args, opts = {}) {
    // The options as given: utf8 is execFile's own default.
    const { stdout, stderr } = await execFileAsync(file, [...args], opts);
    return { stdout: String(stdout), stderr: String(stderr) };
  },

  async execBuffer(file, args, opts = {}) {
    const { stdout } = await execFileAsync(file, [...args], { ...opts, encoding: 'buffer' });
    return { stdout };
  },

  async runLogged(command, { cwd, env, logFile, timeoutMs }) {
    await appendFile(logFile, `\n$ ${command}\n`);
    const fd = openSync(logFile, 'a');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', fd, fd] });
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`"${command}" salió con código ${code}`));
        });
      });
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${await tail(logFile)}`);
    } finally {
      closeSync(fd);
    }
  },

  // Detached into its own process group, so stopGroup can stop it together
  // with whatever it spawned (pnpm → vite, for one).
  startLogged(command, { cwd, env, logFile }) {
    const fd = openSync(logFile, 'a');
    try {
      const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', fd, fd], detached: true });
      child.unref();
      if (child.pid === undefined) throw new Error(`no se pudo arrancar "${command}"`);
      return child.pid;
    } finally {
      closeSync(fd);
    }
  },

  alive: pidAlive,

  freePort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : null;
        server.close(() => (port !== null ? resolve(port) : reject(new Error('no port assigned'))));
      });
    });
  },

  browserMcp(args) {
    return { command: join(process.cwd(), 'node_modules', '.bin', 'playwright-mcp'), args };
  },

  async stopGroup(pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 250));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // exited after SIGTERM
    }
  },
};

let current: Host = localHost;

// The host jobs run on.
export const host = (): Host => current;

// For tests: another host, or back to this machine's.
export function setHost(next: Host | null): void {
  current = next ?? localHost;
}
