import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A worker's lock is a file holding its pid: held while that process lives.
export async function lockHeld(path: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(path, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

// Exclusive create; a lock left by a dead process is taken over.
export async function acquireLock(path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path) && !(await lockHeld(path))) await rm(path, { force: true });
  try {
    const handle = await openFile(path, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

// Starts one of ronin's workers (src/<name>.ts) detached from the tick: same
// runtime (node on dist/, or tsx in development), same environment, the
// request as its one JSON argument. Its output goes to the same daily log the
// cron wrapper writes the tick to (scripts/setup-cron.sh), so its lines sit
// next to the tick's. Returns the worker's pid.
export function launchWorker(name: string, request: unknown): number | undefined {
  const here = fileURLToPath(import.meta.url);
  const worker = join(dirname(here), `${name}${here.endsWith('.ts') ? '.ts' : '.js'}`);
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  mkdirSync(join(process.cwd(), 'logs'), { recursive: true });
  const out = openSync(join(process.cwd(), 'logs', `tick-${day}.log`), 'a');
  try {
    const child = spawn(process.execPath, [...process.execArgv, worker, JSON.stringify(request)], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
  }
}
