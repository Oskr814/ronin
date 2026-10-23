import type { Scope } from '../tick/tick.js';

// The open debounce windows of the webhook server (github.ts), one per repo
// + resources: what's been asked of them so far, and when their handler
// starts. A burst of deliveries about the same thing (a review's several
// inline comments, a few check suites finishing together) is one handler,
// with every flow any of them asked for. Different PRs or issues get their
// own handlers, at once.
//
// Each delivery says how long it may wait (#370): a check suite, long
// enough for the rest of its burst; a comment, a command or an approval,
// barely. One that may wait less than what's left of its window brings it
// forward: nobody waits behind a check suite that happened to come first.

interface Window {
  repo: string;
  scope: Scope;
  receivedAt: number;
  fireAt: number;
  timer: NodeJS.Timeout;
}

export type StartHandler = (repo: string, scope: Scope, receivedAt: number) => void;

export class EventDebouncer {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly start: StartHandler) {}

  schedule(repo: string, scope: Scope, waitMs: number, now = Date.now()): void {
    const key = JSON.stringify([repo, [...scope.resources].sort()]);
    const open = this.windows.get(key);
    if (open) {
      const comments = [...(open.scope.comments ?? []), ...(scope.comments ?? [])];
      open.scope = { ...open.scope, flows: [...new Set([...open.scope.flows, ...scope.flows])], ...(comments.length ? { comments } : {}) };
      if (now + waitMs < open.fireAt) this.arm(key, open, now + waitMs, now);
      return;
    }
    const window = { repo, scope, receivedAt: now, fireAt: 0, timer: undefined as unknown as NodeJS.Timeout };
    this.windows.set(key, window);
    this.arm(key, window, now + waitMs, now);
  }

  // How many windows are still open: for the tests.
  get open(): number {
    return this.windows.size;
  }

  private arm(key: string, window: Window, fireAt: number, now: number): void {
    clearTimeout(window.timer);
    window.fireAt = fireAt;
    window.timer = setTimeout(() => {
      this.windows.delete(key);
      this.start(window.repo, window.scope, window.receivedAt);
    }, fireAt - now);
  }
}
