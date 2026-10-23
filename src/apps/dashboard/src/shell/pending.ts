import { changed } from './state.js';

// What was just written from the page and isn't in what's read yet (#368):
// a comment shows in its conversation at once, as being sent, and stays
// there once GitHub took it until a read of the item brings it — the
// server reads it again right after the write, but the page may ask before
// that read lands. One that fails is taken out, and whoever sent it says why.
// Kept outside the queries, so neither a poll nor a read in between makes it
// blink out.

export interface PendingWrite {
  id: number;
  repo: string;
  // The issue's or the PR's number: the conversation it's in.
  number: number;
  author: string;
  // What's written, as it will read on GitHub; empty for an action without a
  // comment, which says `note` instead ("Se lo asignás a ronin").
  body: string;
  note?: string;
  at: string;
  state: 'sending' | 'sent';
  url?: string;
  sentAt?: number;
}

// A sent one no read brought, past this, was read some other way (an edit,
// a trimmed conversation): it's let go.
const SENT_SHOWN_MS = 2 * 60_000;
let writes: PendingWrite[] = [];
let next = 1;

export function addPending(write: Omit<PendingWrite, 'id' | 'state' | 'at'>): number {
  const id = next++;
  writes = [...writes, { ...write, id, state: 'sending', at: new Date().toISOString() }];
  changed();
  return id;
}

// GitHub took it: still shown, now as sent, until a read brings it.
export function sentPending(id: number, url?: string): void {
  writes = writes.map((w) => (w.id === id ? { ...w, state: 'sent', sentAt: Date.now(), ...(url ? { url } : {}) } : w));
  changed();
}

export function dropPending(id: number): void {
  writes = writes.filter((w) => w.id !== id);
  changed();
}

// The ones still to show in the conversation of `number`: not in what was
// read (by their URL, or by who wrote what), and not sent too long ago.
export function pendingOn(repo: string, number: number, read: Array<{ url: string; author: string; body: string }>, now = Date.now()): PendingWrite[] {
  return writes.filter((w) => w.repo === repo && w.number === number
    && !(w.state === 'sent' && now - (w.sentAt ?? now) > SENT_SHOWN_MS)
    && !read.some((c) => (w.url && c.url === w.url) || (w.body && c.author === w.author && c.body.trim() === w.body.trim())));
}

export function resetPending(): void {
  writes = [];
}
