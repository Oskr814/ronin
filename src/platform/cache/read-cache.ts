import { log } from '../logger.js';

// What the dashboard reads from GitHub, kept (#65, #368): a repo, an item's
// page, a PR's files, an exploration's findings. One cache for all of them:
//
// - A read is fresh for `ttlMs`, and stale once something it depends on
//   changed after it (`changedSince`: a run of it started or ended). A stale
//   one is still served while it's read again in the background; only the
//   first read of something is waited for.
// - After a write, it isn't dropped (#368): `expire` reads it again right
//   away, without waiting for the next request. With `wait`, the next
//   request waits for that read: the person who just wrote expects to see
//   it. Without it (a webhook, the sidebar), what's there is served
//   meanwhile.
// - What the write already knows (the comment just posted) goes straight
//   in with `update`, so nobody waits for it at all.
// - A read that fails keeps the previous one, with the error (`failed`), so
//   the page can say its GitHub data is old; it's tried again on the next
//   request after `ttlMs`.
// - Entries nobody asked for in `forgetMs` are dropped, so the cache
//   doesn't grow with every item ever opened.
//
// Each entry has tags (the repo, "<repo>#<number>" of each issue or PR it
// shows) that a write or a webhook expires it by.

export interface ReadCacheOptions<T> {
  // What it reads, for the log: "los archivos de acme/tienda#12".
  label: (key: string) => string;
  ttlMs: () => number;
  forgetMs?: number;
  // What's served when a read fails: the previous one with the error. If
  // it throws (`error` itself, say), so does the request.
  failed: (previous: T | undefined, message: string, error: unknown) => T;
}

interface Entry<T> {
  data?: T;
  readAt: number;
  usedAt: number;
  // The latest read on its way; a newer one replaces it (a write after it started).
  reading?: Promise<T>;
  generation: number;
  // Written since its last read, by someone who'll ask for it next.
  behind: boolean;
  // Changed while a read was on its way (a burst of webhooks): one more
  // read once that one lands, not one per webhook.
  again: boolean;
  read: () => Promise<T>;
  failed: (previous: T | undefined, message: string, error: unknown) => T;
  tags: string[];
}

export interface GetOptions<T> {
  tags?: string[];
  // This one's own, when what it serves on a failure needs more than the
  // previous read (the PR's branch).
  failed?: (previous: T | undefined, message: string, error: unknown) => T;
  changedSince?: number;
  now?: number;
}

// Something asked for in this long is open on someone's screen: a webhook
// about it reads it again right away. One that isn't waits for its next request.
const IN_USE_MS = 2 * 60_000;

export class ReadCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: ReadCacheOptions<T>) {}

  get(key: string, read: () => Promise<T>, { tags = [], changedSince = 0, now = Date.now(), failed = this.options.failed }: GetOptions<T> = {}): Promise<T> {
    this.sweep(now);
    const entry = this.entries.get(key) ?? { readAt: 0, usedAt: now, generation: 0, behind: false, again: false, read, failed, tags };
    entry.read = read;
    entry.failed = failed;
    entry.tags = tags;
    entry.usedAt = now;
    this.entries.set(key, entry);
    if (entry.data !== undefined && !entry.behind && now - entry.readAt < this.options.ttlMs() && entry.readAt >= changedSince) return Promise.resolve(entry.data);
    const reading = entry.reading ?? this.refresh(key, entry);
    // Behind a write, or never read: what's coming. Otherwise what's there, meanwhile.
    return entry.behind || entry.data === undefined ? reading : Promise.resolve(entry.data);
  }

  // After a write to, or a webhook about, what's tagged `tag`: read again
  // now. `wait`: the next request waits for that read.
  expire(tag: string, { wait = false, now = Date.now() }: { wait?: boolean; now?: number } = {}): void {
    for (const [key, entry] of this.entries) {
      if (!entry.tags.includes(tag)) continue;
      entry.readAt = 0;
      if (wait) {
        // Not the read under way, which may have started before the write.
        entry.behind = true;
        void this.refresh(key, entry);
      } else if (entry.reading) {
        entry.again = true;
      } else if (now - entry.usedAt < IN_USE_MS) {
        void this.refresh(key, entry);
      }
    }
  }

  // Changes what's kept of everything tagged `tag`, as a write left it.
  update(tag: string, change: (data: T) => T): void {
    for (const entry of this.entries.values()) {
      if (entry.tags.includes(tag) && entry.data !== undefined) entry.data = change(entry.data);
    }
  }

  // Drops everything tagged `tag`: its next request reads it from scratch,
  // and waits for it (what it's read with changed, like a repo's settings).
  forget(tag: string): void {
    for (const [key, entry] of this.entries) if (entry.tags.includes(tag)) this.entries.delete(key);
  }

  // Whether anything is kept under `key`, read or on its way.
  has(key: string): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private refresh(key: string, entry: Entry<T>): Promise<T> {
    const generation = ++entry.generation;
    const current = () => entry.generation === generation;
    const reading = entry.read()
      .then((data) => {
        if (current()) {
          entry.data = data;
          entry.readAt = Date.now();
          entry.behind = false;
        }
        return data;
      })
      .catch((error: unknown) => {
        log.error(`tablero: no se pudo leer ${this.options.label(key)} de GitHub`, error);
        const data = entry.failed(entry.data, (error as Error).message.split('\n')[0] ?? '', error);
        if (current()) {
          entry.data = data;
          // Tried again on the next request after the TTL, not on every one of them.
          entry.readAt = Date.now();
          entry.behind = false;
        }
        return data;
      })
      .finally(() => {
        if (entry.reading !== reading) return;
        entry.reading = undefined;
        if (entry.again) {
          entry.again = false;
          entry.readAt = 0;
          void this.refresh(key, entry);
        }
      });
    entry.reading = reading;
    // A read in the background that nobody waits for may still fail (a
    // `failed` that throws): handled here, never an unhandled rejection.
    reading.catch(() => {});
    return reading;
  }

  private sweep(now: number): void {
    const forgetMs = this.options.forgetMs;
    if (forgetMs === undefined) return;
    for (const [key, entry] of this.entries) if (!entry.reading && now - entry.usedAt > forgetMs) this.entries.delete(key);
  }
}
