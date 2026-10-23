import { AsyncLocalStorage } from 'node:async_hooks';
import type { Comment } from './github.js';

// What one run of the tick reads from GitHub once and every step shares
// (#370): the repo's open PRs, which sweeps, auto-merge, discovery, the
// review of other people's PRs and the exploration PRs used to list each on
// its own, five or six times a tick. Only inside withGithubMemo (the tick's
// run for one repo); anywhere else (the dashboard) every read goes to
// GitHub as before.
//
// Never staler than the run's own writes: any write to GitHub empties it,
// so a step after a merge or a label reads again. And never older than
// MEMO_MS, because a run's jobs can go on for minutes.

const MEMO_MS = 2 * 60 * 1000;

interface Entry {
  at: number;
  read: Promise<unknown>;
}

const store = new AsyncLocalStorage<Map<string, Entry>>();

// A comment the webhook brought (#370), with the issue or PR it's on.
export interface EventComment {
  number: number;
  comment: Comment;
}

// The comments of the events a run is for: what was said doesn't change
// (an edit is another event), so unlike the memo a write doesn't empty it.
const eventStore = new AsyncLocalStorage<EventComment[]>();

export function withGithubMemo<T>(fn: () => Promise<T>, comments?: EventComment[]): Promise<T> {
  return store.run(new Map(), () => (comments?.length ? eventStore.run(comments, fn) : fn()));
}

// The comments an event brought for this issue or PR; undefined when it
// brought none, and its comments are read as usual.
export function eventCommentsFor(number: number): Comment[] | undefined {
  const found = eventStore.getStore()?.filter((c) => c.number === number).map((c) => c.comment);
  return found?.length ? found : undefined;
}

// read()'s answer, shared by whoever asks for the same key in this run; a
// read that fails is not kept, so the next one tries again.
export function memoized<T>(key: string, read: () => Promise<T>, now = Date.now()): Promise<T> {
  const memo = store.getStore();
  if (!memo) return read();
  const entry = memo.get(key);
  if (entry && now - entry.at <= MEMO_MS) return entry.read as Promise<T>;
  const promise = read();
  memo.set(key, { at: now, read: promise });
  promise.catch(() => {
    if (memo.get(key)?.read === promise) memo.delete(key);
  });
  return promise;
}

// What another read of the run already brought (an issue's body, in the
// list of issues), kept as if it had been read on its own. Outside a run,
// nothing.
export function remember<T>(key: string, value: T, now = Date.now()): void {
  store.getStore()?.set(key, { at: now, read: Promise.resolve(value) });
}

export const inGithubMemo = (): boolean => store.getStore() !== undefined;

export function forgetGithubMemo(): void {
  store.getStore()?.clear();
}

// Whether a gh command changes something on GitHub. `gh pr list`, `view`,
// `checks`… only read; `gh label create` writes, but no label it creates
// changes a PR, and ensureLabel runs it every tick.
const READ_VERBS = new Set(['list', 'view', 'status', 'checks', 'diff']);

export function ghWrites(args: readonly string[]): boolean {
  if (args[0] === 'api') return ghApiWrites(args);
  if (args[0] === 'label' && args[1] === 'create') return false;
  return !READ_VERBS.has(args[1] ?? '');
}

// `gh api`: GraphQL writes only with a mutation; REST by its method, which
// is GET unless -X says otherwise or there are fields (then gh sends POST).
function ghApiWrites(args: readonly string[]): boolean {
  if (args[1] === 'graphql') return args.some((a) => /^query=\s*mutation\b/.test(a));
  const method = args.findIndex((a) => a === '-X' || a === '--method');
  if (method !== -1) return (args[method + 1] ?? '').toUpperCase() !== 'GET';
  return args.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
}
