import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from './worker-launch.js';
import { activeRepo } from './repo-context.js';
import { getDb } from '../db/db.js';
import { clearWaiting, markWaiting, release as releaseInDb, tryTake } from './locks-db.js';

// Who works on what, across every ronin process on this runner: the cron
// tick and the event handlers the webhook server starts
// (apps/api/webhooks/handler.ts) can run at the same time, so two of them must never
// take the same issue or PR at once. Each lock is a file holding its
// process's pid (worker-launch.ts's acquireLock), so one left behind by a
// process that died is taken over instead of blocking forever. See
// docs/DESIGN.md §14. With DATABASE_URL (#235, stage 3.2), each lock is a row
// in Postgres instead, with a lease its process renews (locks-db.ts): the
// same rules, without files.

// A resource is what a lock protects, inside the active repo: an issue
// (its whole stack of slice PRs, and its ronin/<n>/* worktrees), a PR ronin
// doesn't manage the stack of, or a repo-wide step like the auto-merge sweep.
export const issueResource = (n: number): string => `issue-${n}`;
export const prResource = (n: number): string => `pr-${n}`;

const POLL_MS = 2000;

// A lock: its file, or its row (scope: the repo; name: issue-12, all-0…).
// `id` names it either way, inside this process.
interface Key {
  path: string;
  scope: string;
  name: string;
}
const idOf = (key: Key) => `${key.scope}\u0000${key.path}`;

// Locks this process took, so two of its own concurrent jobs never share
// one (a file alone can't tell them apart: both hold the same pid).
const held = new Set<string>();
// Held for the whole run of an event handler (pinResources): a job for one
// of these finds it already taken by its own process, and goes ahead.
const pinned = new Set<string>();

function resourceKey(resource: string): Key {
  return { path: join(activeRepo().worktreeBasePath, '.locks', `${resource}.lock`), scope: activeRepo().productRepo, name: resource };
}

async function take(key: Key): Promise<boolean> {
  if (held.has(idOf(key))) return false;
  held.add(idOf(key));
  const db = getDb();
  if (await (db ? tryTake(db, key.scope, key.name) : acquireLock(key.path))) return true;
  held.delete(idOf(key));
  return false;
}

async function release(key: Key): Promise<void> {
  if (!held.delete(idOf(key))) return;
  const db = getDb();
  if (db) await releaseInDb(db, key.scope, key.name);
  else await rm(key.path, { force: true });
}

// Never waits: false means another process (or another job of this one) has
// it right now.
export async function tryLockResource(resource: string): Promise<boolean> {
  const key = resourceKey(resource);
  return pinned.has(idOf(key)) || take(key);
}

export async function unlockResource(resource: string): Promise<void> {
  const key = resourceKey(resource);
  if (!pinned.has(idOf(key))) await release(key);
}

export async function waitLockResource(resource: string): Promise<void> {
  while (!(await tryLockResource(resource))) await sleep(POLL_MS);
}

// Runs fn holding the resource. 'skip' gives up right away when it's taken
// (the tick: whoever has it is already on it); 'wait' waits its turn (an
// event handler: its event has to be seen once the holder is done).
export async function withResourceLock(resource: string, mode: 'skip' | 'wait', fn: () => Promise<void>): Promise<boolean> {
  if (mode === 'wait') await waitLockResource(resource);
  else if (!(await tryLockResource(resource))) return false;
  try {
    await fn();
  } finally {
    await unlockResource(resource);
  }
  return true;
}

// An event handler takes every resource its event touches before reading
// anything from GitHub, waiting for each in turn: what it reads afterwards
// is fresh, never what was there before the holder it waited on acted. In
// sorted order, so two handlers taking overlapping sets can't deadlock.
const pinnedKeys = new Map<string, Key>();
export async function pinResources(resources: string[]): Promise<void> {
  for (const resource of [...new Set(resources)].sort()) {
    await waitLockResource(resource);
    const key = resourceKey(resource);
    pinned.add(idOf(key));
    pinnedKeys.set(idOf(key), key);
  }
}

export async function unpinResources(): Promise<void> {
  for (const [id, key] of [...pinnedKeys]) {
    pinned.delete(id);
    pinnedKeys.delete(id);
    await release(key);
  }
}

// Slots shared by every process on the runner, per repo: each repo is its
// own queue (and usually its own Claude account, whose quota they protect),
// so a repo with a lot assigned never holds another back. `limit` slots
// overall in the repo (its `concurrency`, see config.ts's concurrencyFor),
// and caps[kind] of one kind — the same numbers runJobs applies inside one
// process. Named <repo, URI-encoded>~all-<i>.lock (dashboard-data.ts's
// slotsInUse reads them).
function slotKey(name: string): Key {
  const repo = repoName();
  return { path: join(process.cwd(), '.ronin-slots', `${repo ? `${encodeURIComponent(repo)}~` : ''}${name}.lock`), scope: repo ?? '', name };
}

function repoName(): string | undefined {
  try {
    return activeRepo().productRepo;
  } catch {
    return undefined;
  }
}

async function takeSlot(prefix: string, count: number, onWait: () => Promise<void>): Promise<Key> {
  for (;;) {
    for (let i = 0; i < count; i++) {
      const key = slotKey(`${prefix}-${i}`);
      if (await take(key)) return key;
    }
    await onWait();
    await sleep(POLL_MS);
  }
}

// What's waiting for a slot right now, for the dashboard's queue
// (#65): a file per waiting job, from its first failed try
// until it has its slots. One left by a dead process is ignored (its pid).
let waitSeq = 0;

class WaitMark {
  private path: string | null = null;
  private row: string | null = null;

  constructor(private readonly kind: string, private readonly label: string) {}

  async set(): Promise<void> {
    if (this.path || this.row) return;
    const db = getDb();
    if (db) {
      const repo = repoName();
      this.row = await markWaiting(db, { kind: this.kind, label: this.label, ...(repo ? { repo } : {}) }).catch(() => null);
      return;
    }
    this.path = join(process.cwd(), '.ronin-slots', 'waiting', `${process.pid}-${++waitSeq}.json`);
    const repo = repoName();
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify({ pid: process.pid, kind: this.kind, label: this.label, repo, since: new Date().toISOString() }));
    } catch {
      // Only the dashboard loses it; the job waits all the same.
    }
  }

  async clear(): Promise<void> {
    if (this.row) {
      const row = this.row;
      this.row = null;
      const db = getDb();
      if (db) await clearWaiting(db, row).catch(() => {});
      return;
    }
    if (!this.path) return;
    const path = this.path;
    this.path = null;
    await rm(path, { force: true }).catch(() => {});
  }
}

export async function withSlots<T>(kind: string, limit: number, caps: Record<string, number>, fn: () => Promise<T>, label = kind): Promise<T> {
  const mark = new WaitMark(kind, label);
  const onWait = () => mark.set();
  try {
    const cap = caps[kind];
    const kindSlot = cap === undefined ? null : await takeSlot(`kind-${kind}`, cap, onWait);
    try {
      const slot = await takeSlot('all', limit, onWait);
      await mark.clear();
      try {
        return await fn();
      } finally {
        await release(slot);
      }
    } finally {
      if (kindSlot) await release(kindSlot);
    }
  } finally {
    await mark.clear();
  }
}
