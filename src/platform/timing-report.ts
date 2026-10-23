import { BUCKETS, percentile, type RouteWindow, type Span } from './timing.js';

// What `pnpm timings` prints (scripts/timings.ts): the API's routes and the
// tick's steps over the last days, the baseline the stages of #235 compare
// against.

export interface RouteSummary {
  listener: string;
  method: string;
  route: string;
  count: number;
  errors: number;
  avgMs: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  maxMs: number;
  // Per request, on average.
  githubMs: number;
  githubCalls: number;
  // By operation, per request on average, the heaviest first (#370).
  githubOps: GithubOp[];
}

export interface GithubOp {
  name: string;
  ms: number;
  calls: number;
}

// The operations of several measurements, summed and then divided by how
// many there were: what each costs per request or per tick, heaviest first.
export function averageOps(ops: Array<Record<string, Span> | undefined>, over: number): GithubOp[] {
  const sums = new Map<string, Span>();
  for (const one of ops) {
    for (const [name, s] of Object.entries(one ?? {})) {
      const sum = sums.get(name) ?? { ms: 0, count: 0 };
      sums.set(name, { ms: sum.ms + s.ms, count: sum.count + s.count });
    }
  }
  return [...sums].map(([name, s]) => ({ name, ms: over ? s.ms / over : 0, calls: over ? s.count / over : 0 })).sort((a, b) => b.ms - a.ms);
}

export function summarizeRoutes(windows: RouteWindow[]): RouteSummary[] {
  const byRoute = new Map<string, RouteWindow[]>();
  for (const w of windows) {
    const key = `${w.listener} ${w.method} ${w.route}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), w]);
  }
  return [...byRoute.values()].map((ws) => {
    const count = ws.reduce((n, w) => n + w.count, 0);
    const buckets = BUCKETS.map(() => 0).concat(0);
    for (const w of ws) w.buckets.forEach((n, i) => { buckets[i] += n; });
    const sum = (f: (w: RouteWindow) => number) => ws.reduce((n, w) => n + f(w), 0);
    return {
      listener: ws[0].listener, method: ws[0].method, route: ws[0].route, count,
      errors: sum((w) => w.errors),
      avgMs: count ? sum((w) => w.totalMs) / count : 0,
      p50: percentile(buckets, 0.5), p90: percentile(buckets, 0.9), p99: percentile(buckets, 0.99),
      maxMs: Math.max(...ws.map((w) => w.maxMs)),
      githubMs: count ? sum((w) => w.githubMs) / count : 0,
      githubCalls: count ? sum((w) => w.githubCount) / count : 0,
      githubOps: averageOps(ws.map((w) => w.githubOps), count),
    };
  }).sort((a, b) => b.avgMs * b.count - a.avgMs * a.count);
}

// A tick_complete line of the tick log (tick.ts), with what stage 1 added.
export interface TickMetric {
  repo: string;
  durationMs: number;
  agentRunsDurationMs?: number;
  steps?: Record<string, number>;
  discoveryMs?: number;
  jobsMs?: number;
  githubMs?: number;
  githubCalls?: number;
  githubOps?: Record<string, Span>;
}

export interface TickSummary {
  repo: string;
  ticks: number;
  p50: number;
  p90: number;
  max: number;
  // Medians, of the ticks that measured them.
  steps: Record<string, number>;
  discoveryMs: number | null;
  jobsMs: number | null;
  githubMs: number | null;
  githubCalls: number | null;
  // By operation, per tick on average, of the ticks that measured them.
  githubOps: GithubOp[];
}

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const medianOf = (values: Array<number | undefined>): number | null => {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length ? quantile(present, 0.5) : null;
};

export function summarizeTicks(metrics: TickMetric[]): TickSummary[] {
  const byRepo = new Map<string, TickMetric[]>();
  for (const m of metrics) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m]);
  return [...byRepo.entries()].map(([repo, ms]) => {
    const durations = ms.map((m) => m.durationMs);
    const names = [...new Set(ms.flatMap((m) => Object.keys(m.steps ?? {})))];
    return {
      repo, ticks: ms.length,
      p50: quantile(durations, 0.5), p90: quantile(durations, 0.9), max: Math.max(...durations),
      steps: Object.fromEntries(names.map((name) => [name, medianOf(ms.map((m) => m.steps?.[name]))!])),
      discoveryMs: medianOf(ms.map((m) => m.discoveryMs)),
      jobsMs: medianOf(ms.map((m) => m.jobsMs)),
      githubMs: medianOf(ms.map((m) => m.githubMs)),
      githubCalls: medianOf(ms.map((m) => m.githubCalls)),
      githubOps: averageOps(ms.map((m) => m.githubOps), ms.filter((m) => m.githubOps).length),
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
}

// The tick log's lines are free text and metrics; only tick_complete counts.
export function tickMetricsOf(text: string): TickMetric[] {
  const metrics: TickMetric[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"tick_complete"')) continue;
    try {
      const parsed = JSON.parse(line.slice(line.indexOf('{'))) as TickMetric & { event?: string };
      if (parsed.event === 'tick_complete' && typeof parsed.durationMs === 'number' && parsed.repo) metrics.push(parsed);
    } catch {
      // Not one of ours.
    }
  }
  return metrics;
}

export const ms = (v: number | null): string => (v === null ? '—' : v === Infinity ? `>${BUCKETS.at(-1)! / 1000} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
