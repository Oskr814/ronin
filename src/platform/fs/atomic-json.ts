import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from '../workers/worker-launch.js';

// JSON files that are the only copy of their data (the portal's accounts and
// requests, meetings, deploys, Ajustes without DATABASE_URL) — unlike
// .ronin-state.json, a cache — so a file that doesn't read is an error, never
// an empty value; only a missing one gets the default.

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

// Written aside and renamed into place: whoever reads it meanwhile sees the
// old file or the new one, never half of one. `private`: readable only by
// this user.
export async function writeFileAtomic(path: string, text: string, opts: { private?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, ...(opts.private ? { mode: 0o700 } : {}) });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, opts.private ? { mode: 0o600 } : {});
  await rename(tmp, path);
}

// The same, for a process that can't wait (the usage of a run as it ends).
export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writeJson(path: string, data: unknown): Promise<void> {
  return writeFileAtomic(path, JSON.stringify(data, null, 2), { private: true });
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
