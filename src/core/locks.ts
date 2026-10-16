import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock } from './worker-launch.js';
import { activeRepo } from './repo-context.js';

// Who works on what, across every ronin process on this runner: the cron
// tick and the event handlers the webhook server starts
// (webhooks/handler.ts) can run at the same time, so two of them must never
// take the same issue or PR at once. Each lock is a file holding its
// process's pid (worker-launch.ts's acquireLock), so one left behind by a
// process that died is taken over instead of blocking forever. See
// docs/DESIGN.md §14.

// A resource is what a lock protects, inside the active repo: an issue
// (its whole stack of slice PRs, and its ronin/<n>/* worktrees), a PR ronin
// doesn't manage the stack of, or a repo-wide step like the auto-merge sweep.
export const issueResource = (n: number): string => `issue-${n}`;
export const prResource = (n: number): string => `pr-${n}`;

const POLL_MS = 2000;

// Lock files this process created, so two of its own concurrent jobs never
// share one (the file alone can't tell them apart: both hold the same pid).
const held = new Set<string>();
// Held for the whole run of an event handler (pinResources): a job for one
// of these finds it already taken by its own process, and goes ahead.
const pinned = new Set<string>();

function resourcePath(resource: string): string {
  return join(activeRepo().worktreeBasePath, '.locks', `${resource}.lock`);
}

async function take(path: string): Promise<boolean> {
  if (held.has(path)) return false;
  held.add(path);
  if (await acquireLock(path)) return true;
  held.delete(path);
  return false;
}

async function release(path: string): Promise<void> {
  if (!held.delete(path)) return;
  await rm(path, { force: true });
}

// Never waits: false means another process (or another job of this one) has
// it right now.
export async function tryLockResource(resource: string): Promise<boolean> {
  const path = resourcePath(resource);
  return pinned.has(path) || take(path);
}

export async function unlockResource(resource: string): Promise<void> {
  const path = resourcePath(resource);
  if (!pinned.has(path)) await release(path);
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
export async function pinResources(resources: string[]): Promise<void> {
  for (const resource of [...new Set(resources)].sort()) {
    await waitLockResource(resource);
    pinned.add(resourcePath(resource));
  }
}

export async function unpinResources(): Promise<void> {
  for (const path of [...pinned]) {
    pinned.delete(path);
    await release(path);
  }
}

// Slots shared by every process on the runner, not per repo: the quota they
// protect is the Claude account's. `limit` slots overall, and caps[kind] of
// one kind — the same numbers runJobs applies inside one process.
function slotPath(name: string): string {
  return join(process.cwd(), '.ronin-slots', `${name}.lock`);
}

async function takeSlot(prefix: string, count: number, onWait: () => Promise<void>): Promise<string> {
  for (;;) {
    for (let i = 0; i < count; i++) {
      const path = slotPath(`${prefix}-${i}`);
      if (await take(path)) return path;
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

  constructor(private readonly kind: string, private readonly label: string) {}

  async set(): Promise<void> {
    if (this.path) return;
    this.path = join(process.cwd(), '.ronin-slots', 'waiting', `${process.pid}-${++waitSeq}.json`);
    let repo: string | undefined;
    try {
      repo = activeRepo().productRepo;
    } catch {
      repo = undefined;
    }
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify({ pid: process.pid, kind: this.kind, label: this.label, repo, since: new Date().toISOString() }));
    } catch {
      // Only the dashboard loses it; the job waits all the same.
    }
  }

  async clear(): Promise<void> {
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
