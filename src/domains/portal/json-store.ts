import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from '../../platform/workers/worker-launch.js';

// The portal's files (#114): accounts and requests are the only copy there
// is — unlike .ronin-state.json, a cache — so a file that doesn't read is an
// error, never an empty value; only a missing one gets the default.

const LOCK_POLL_MS = 50;

export async function readJson<T>(path: string, fallback: () => T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw error;
  }
  return JSON.parse(raw) as T;
}

// Written aside and renamed into place, readable only by this user.
export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

// Read, change and write one file under a lock shared by every process (the
// server, the portal's workers, the tick), and in order inside this one.
// Written only when `fn` changed something.
const queues = new Map<string, Promise<unknown>>();
export function withJson<T, R>(path: string, fallback: () => T, fn: (data: T) => R | Promise<R>): Promise<R> {
  const locked = async () => {
    const lock = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    while (!(await acquireLock(lock))) await sleep(LOCK_POLL_MS);
    try {
      const data = await readJson(path, fallback);
      const before = JSON.stringify(data);
      const result = await fn(data);
      if (JSON.stringify(data) !== before) await writeJson(path, data);
      return result;
    } finally {
      await rm(lock, { force: true });
    }
  };
  const result = (queues.get(path) ?? Promise.resolve()).then(locked, locked);
  queues.set(path, result.then(() => {}, () => {}));
  return result;
}
