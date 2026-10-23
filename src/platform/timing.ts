import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, logsDir } from './agents/run-files.js';

// How long ronin takes (#235, stage 1): what a request of the API or a step
// of the tick spent, and how much of it went to GitHub. A measurement is an
// AsyncLocalStorage context: whatever runs inside it, however deep, adds its
// spans with timed() without being handed anything. Outside of one, timed()
// only runs what it's given.

export interface Span {
  ms: number;
  count: number;
}

export interface Measurement {
  start: number;
  spans: Map<string, Span>;
}

const store = new AsyncLocalStorage<Measurement>();

// Runs fn inside a new measurement, handed to it too.
export function measure<T>(fn: (measurement: Measurement) => T, now = performance.now()): T {
  const measurement: Measurement = { start: now, spans: new Map() };
  return store.run(measurement, () => fn(measurement));
}

export const currentMeasurement = () => store.getStore();

// Adds what fn took to the current measurement's span of that name. Spans
// that overlap (GitHub calls made at once) add up, so a span can be longer
// than the whole: it says how much was spent there, not how long it waited.
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const measurement = store.getStore();
  if (!measurement) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const span = measurement.spans.get(name) ?? { ms: 0, count: 0 };
    span.ms += performance.now() - start;
    span.count += 1;
    measurement.spans.set(name, span);
  }
}

const round = (ms: number) => Math.round(ms * 10) / 10;

// ---------- GitHub, by what asked for it (#370)

// A GitHub call counts in the "github" span, as always, and in one of its
// own, "github:<operation>": the function of ronin that made the call
// (listAllOpenRoninPrs, getIssueBody…), read off the stack. So the six
// open-PR lists of a tick come out apart, and no call site has to name
// itself. These are the wrappers every call goes through, never the name.
export const GITHUB_SPAN = 'github';
const GITHUB_OP = 'github:';
const GITHUB_WRAPPERS = new Set(['gh', 'ghApi', 'ghGraphql', 'githubFetch', 'call', 'graphql', 'timed', 'timedGithub', 'githubCaller', 'memoized']);

// The first named function on the stack that isn't a wrapper: "at listX
// (file…)" or "at async listX (file…)", with Object. or Module. dropped (a
// call through `import * as`). A frame
// without a name (a callback) or of the runtime (Array.map) is skipped.
export function githubCaller(stack = new Error().stack ?? ''): string {
  for (const line of stack.split('\n').slice(1)) {
    const name = /^\s*at (?:async )?(?:Object\.|Module\.)?([\w$.]+) \(/.exec(line)?.[1];
    if (!name || name.includes('.') || GITHUB_WRAPPERS.has(name)) continue;
    return name;
  }
  return 'desconocida';
}

// What fn took, in "github" and in its operation's span. The operation is
// read when the call starts, while its caller is still on the stack.
export function timedGithub<T>(fn: () => Promise<T>, operation = githubCaller()): Promise<T> {
  return timed(GITHUB_SPAN, () => timed(`${GITHUB_OP}${operation}`, fn));
}

// The operations of a measurement, by name: what each took and how many
// calls it made.
export function githubOpsOf(spans: Measurement['spans']): Record<string, Span> {
  return Object.fromEntries([...spans].filter(([name]) => name.startsWith(GITHUB_OP)).map(([name, s]) => [name.slice(GITHUB_OP.length), { ms: Math.round(s.ms), count: s.count }]));
}


// The Server-Timing header: the total so far, then each span with how many
// times it ran (DevTools shows them under the request's Timing tab).
export function serverTiming(measurement: Measurement, now = performance.now()): string {
  return [`total;dur=${round(now - measurement.start)}`, ...[...measurement.spans].map(([name, s]) => `${name};dur=${round(s.ms)};desc="${s.count}"`)].join(', ');
}

export const spansOf = (measurement: Measurement) => Object.fromEntries([...measurement.spans].map(([name, s]) => [name, { ms: round(s.ms), count: s.count }]));

// ---------- the API's requests, summed up by route every few minutes

// The same route whatever the number or the repo in it:
// /api/portal/requests/26/interview → /api/portal/requests/:n/interview.
// A segment with a digit or an encoded character is an id (a run, an item,
// a repo, an image): the route keeps its shape, not its values.
export function routeOf(path: string): string {
  return path.split('/').map((part) => (/^\d+$/.test(part) ? ':n' : /[\d%#~@.]/.test(part) ? ':id' : part)).join('/');
}

// Upper bounds of each bucket, in ms; the last one is everything above.
export const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export interface RouteWindow {
  // When the window started and ended.
  from: string;
  to: string;
  listener: string;
  method: string;
  route: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  // How many requests fell in each bucket of BUCKETS, plus one above.
  buckets: number[];
  githubMs: number;
  githubCount: number;
  // By operation (#370); absent in the lines written before.
  githubOps?: Record<string, Span>;
}

export class RouteTimings {
  private windows = new Map<string, RouteWindow>();
  private from = new Date();

  record(entry: { listener: string; method: string; route: string; status: number; ms: number; spans: Measurement['spans'] }): void {
    const key = `${entry.listener} ${entry.method} ${entry.route}`;
    const w = this.windows.get(key) ?? { from: '', to: '', listener: entry.listener, method: entry.method, route: entry.route, count: 0, errors: 0, totalMs: 0, maxMs: 0, buckets: BUCKETS.map(() => 0).concat(0), githubMs: 0, githubCount: 0 };
    w.count += 1;
    if (entry.status >= 500) w.errors += 1;
    w.totalMs += entry.ms;
    w.maxMs = Math.max(w.maxMs, entry.ms);
    const i = BUCKETS.findIndex((upper) => entry.ms <= upper);
    w.buckets[i === -1 ? BUCKETS.length : i] += 1;
    const github = entry.spans.get(GITHUB_SPAN);
    if (github) {
      w.githubMs += github.ms;
      w.githubCount += github.count;
    }
    for (const [name, op] of Object.entries(githubOpsOf(entry.spans))) {
      const ops = (w.githubOps ??= {});
      const sum = ops[name] ?? { ms: 0, count: 0 };
      ops[name] = { ms: sum.ms + op.ms, count: sum.count + op.count };
    }
    this.windows.set(key, w);
  }

  // What was recorded since the last flush, one line per route; the next
  // window starts empty.
  flush(now = new Date()): RouteWindow[] {
    const lines = [...this.windows.values()].map((w) => ({ ...w, from: this.from.toISOString(), to: now.toISOString(), totalMs: round(w.totalMs), maxMs: round(w.maxMs), githubMs: round(w.githubMs) }));
    this.windows.clear();
    this.from = now;
    return lines;
  }
}

export const timingsPath = (day: string) => join(logsDir(), 'timings', `${day}.jsonl`);

// Never throws: a summary that can't be written must never touch a request.
export function writeTimings(lines: RouteWindow[], now = new Date()): void {
  if (!lines.length) return;
  try {
    mkdirSync(join(logsDir(), 'timings'), { recursive: true });
    appendFileSync(timingsPath(localDay(now)), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  } catch {
    // The next window tries again.
  }
}

// The percentile p (0..1) of a set of bucket counts: the upper bound of the
// bucket it falls in (the last one has no bound: it says "more than").
export function percentile(buckets: number[], p: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (const [i, n] of buckets.entries()) {
    seen += n;
    if (seen >= p * total) return i < BUCKETS.length ? BUCKETS[i] : Infinity;
  }
  return Infinity;
}
