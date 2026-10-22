import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive } from './process.js';

// A worker's lock is a file holding its pid: held while that process lives.
export async function lockHeld(path: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(path, 'utf8')).trim());
    return pidAlive(pid);
  } catch {
    return false;
  }
}

// Exclusive create; a lock left by a dead process is taken over. The pid is
// written to a temporary file first and published with link(), which fails
// if the lock exists: created and written in one step, so no other process
// ever reads a lock still empty — and takes it for a dead one's — between
// the create and the write.
export async function acquireLock(path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path) && !(await lockHeld(path))) await rm(path, { force: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, String(process.pid));
  try {
    await link(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    await rm(tmp, { force: true });
  }
}

// Starts one of ronin's workers (src/<name>.ts, e.g. 'domains/previews/worker') detached from the tick: same
// runtime (node on dist/, or tsx in development), same environment, the
// request as its one JSON argument. Its output goes to the same daily log the
// cron wrapper writes the tick to (scripts/setup-cron.sh), so its lines sit
// next to the tick's. Returns the worker's pid.
export function launchWorker(name: string, request: unknown): number | undefined {
  if (handOver) {
    handOver(name, request);
    return undefined;
  }
  return launchScript(name, [JSON.stringify(request)]);
}

// Where a process that must not start workers itself sends them instead:
// the API, when the runner is a container of its own (#325), queues them,
// so redeploying the API doesn't take a worker down with it.
let handOver: ((name: string, request: unknown) => void) | null = null;
export function handWorkersTo(fn: ((name: string, request: unknown) => void) | null): void {
  handOver = fn;
}

// The same for any of ronin's entry points, with its arguments and anything
// added to its environment (the job queue's RONIN_JOB_ID, apps/api/jobs/runner.ts).
export function launchScript(name: string, args: string[], env: Record<string, string> = {}): number | undefined {
  const here = fileURLToPath(import.meta.url);
  const script = join(dirname(here), '..', '..', `${name}${here.endsWith('.ts') ? '.ts' : '.js'}`);
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
  const out = openSync(join(process.cwd(), 'logs', `tick-${day}.log`), 'a');
  try {
    const child = spawn(process.execPath, [...process.execArgv, script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
  }
}
