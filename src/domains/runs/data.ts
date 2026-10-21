import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { logsDir, localDay } from '../../platform/agents/run-files.js';
import { getDb } from '../../platform/db/db.js';
import { pidAlive } from '../../platform/workers/process.js';
import { listRunsDb, putRun, thisHost } from '../../platform/agents/runs-store.js';
import { stepText, type RunLine, type RunOutcome, type RunSummary } from '../../platform/agents/run-record.js';

// What the dashboard reads from this runner's own files (#65): the per-run
// records (logs/runs/), each account's usage (logs/usage/), the agent slots
// and what waits for one (.ronin-slots/), and the tick log's metrics. All of
// it local: what needs GitHub (titles, slices, labels) comes later.

export type { RunLine, RunState, RunSummary } from '../../platform/agents/run-record.js';

// How far back the dashboard looks for an item's runs.
export const HISTORY_DAYS = 14;

export const RUN_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})T\d{6}-[a-z0-9-]+$/;

export function runPath(runId: string): string | null {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) return null;
  return join(logsDir(), 'runs', `${match[1]}-${match[2]}-${match[3]}`, `${runId}.jsonl`);
}

export function readRunLines(path: string): RunLine[] {
  const lines: RunLine[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as RunLine);
    } catch {
      // A line half written right now: the next read has it whole.
    }
  }
  return lines;
}

export function summarizeRun(lines: RunLine[]): RunSummary | null {
  const start = lines[0];
  if (start?.type !== 'run_start') return null;
  const end = lines.find((line) => line.type === 'run_end');
  const steps = lines.filter((line) => line.type === 'text' || line.type === 'tool' || line.type === 'tool_error');
  const last = steps.at(-1);
  const pick = <T>(key: string) => (start[key] as T | undefined);
  // The portal request it was about (#132): runs from before it was
  // recorded only say so in their label ("pedido P-2", "pedido P-2 (prototipo)").
  const portalRequest = pick<number>('portalRequest') ?? (/^portal-/.test(String(start.taskType)) ? Number(/^pedido P-(\d+)\b/.exec(String(start.label ?? ''))?.[1]) || undefined : undefined);
  return {
    runId: String(start.runId),
    repo: String(start.repo),
    taskType: String(start.taskType),
    label: String(start.label ?? ''),
    ...(pick<number>('issueNumber') !== undefined ? { issueNumber: pick<number>('issueNumber') } : {}),
    ...(pick<number>('prNumber') !== undefined ? { prNumber: pick<number>('prNumber') } : {}),
    ...(portalRequest !== undefined ? { portalRequest } : {}),
    ...(pick<number>('meeting') !== undefined ? { meeting: pick<number>('meeting') } : {}),
    ...(pick<number>('sliceIndex') !== undefined ? { sliceIndex: pick<number>('sliceIndex'), sliceTitle: pick<string>('sliceTitle') } : {}),
    ...(pick<string>('group') ? { group: pick<string>('group') } : {}),
    ...(pick<string>('model') ? { model: pick<string>('model') } : {}),
    ...(pick<string>('effort') ? { effort: pick<string>('effort') } : {}),
    account: String(start.account ?? ''),
    worktree: String(start.worktree ?? ''),
    startedAt: String(start.startedAt),
    ...(end ? { endedAt: String(end.endedAt), durationMs: Number(end.durationMs) } : {}),
    ...(typeof end?.costUsd === 'number' ? { costUsd: end.costUsd } : {}),
    ...(typeof end?.error === 'string' ? { error: end.error } : {}),
    state: end ? (end.outcome as RunOutcome) : pidAlive(start.pid) ? 'running' : 'cut',
    steps: steps.length,
    ...(last ? { lastStep: stepText(last) } : {}),
  };
}

// Parsed files, kept while their size doesn't change: a finished run's file
// never does, so a snapshot only re-reads the runs still going.
const cache = new Map<string, { size: number; summary: RunSummary | null }>();

// With DATABASE_URL (#235, stage 3.4), from the index (platform/agents/runs-store.ts):
// only a run still going is read from its file, for its steps so far and to
// see whether its process is still there. One the file says ended — its end
// never reached the index — is caught up from the file.
export async function listRuns(days: number, now = new Date()): Promise<RunSummary[]> {
  const wanted = new Set(Array.from({ length: days }, (_, i) => localDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000))));
  const db = getDb();
  if (!db) return listRunFiles(wanted);
  return Promise.all((await listRunsDb(db, [...wanted])).map(async ({ summary, pid, host }) => {
    if (summary.endedAt) return summary;
    const path = runPath(summary.runId);
    const live = path && existsSync(path) ? summarizeRun(readRunLines(path)) : null;
    if (live?.endedAt) {
      await putRun(db, live).catch(() => {});
      return live;
    }
    // Only this host can tell whether the process is gone.
    const state = host !== null && host !== thisHost() ? 'running' : live?.state ?? (pidAlive(pid) ? 'running' : 'cut');
    return { ...summary, ...(live ? { steps: live.steps, ...(live.lastStep ? { lastStep: live.lastStep } : {}) } : {}), state };
  }));
}

function listRunFiles(wanted: Set<string>): RunSummary[] {
  const root = join(logsDir(), 'runs');
  if (!existsSync(root)) return [];
  const runs: RunSummary[] = [];
  for (const day of readdirSync(root)) {
    if (!wanted.has(day)) continue;
    for (const file of readdirSync(join(root, day))) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(root, day, file);
      try {
        const { size } = statSync(path);
        let entry = cache.get(path);
        if (!entry || entry.size !== size) {
          entry = { size, summary: summarizeRun(readRunLines(path)) };
          cache.set(path, entry);
        }
        // A run still going is re-checked every time: its process may have died.
        const summary = entry.summary && !entry.summary.endedAt ? summarizeRun(readRunLines(path)) : entry.summary;
        if (summary) runs.push(summary);
      } catch {
        // Gone between the listing and the read (the daily prune).
      }
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// What the dashboard calls an item: the issue or PR a run was about, or —
// for runs about neither (a changelog entry, an exploration) — its task and
// label.
export function itemKey(run: Pick<RunSummary, 'repo' | 'issueNumber' | 'prNumber' | 'taskType' | 'label'>): string {
  const number = run.issueNumber ?? run.prNumber;
  return number !== undefined ? `${run.repo}#${number}` : `${run.repo}:${run.taskType}:${run.label}`;
}

// The agent slots taken in each repo (platform/locks/locks.ts): one lock file per slot,
// holding its process's pid. Repo → how many; '' for a slot taken outside
// any repo.
export function slotsInUse(root = process.cwd()): Record<string, number> {
  const dir = join(root, '.ronin-slots');
  const used: Record<string, number> = {};
  if (!existsSync(dir)) return used;
  for (const file of readdirSync(dir)) {
    const match = /^(?:(.+)~)?all-\d+\.lock$/.exec(file);
    if (!match) continue;
    try {
      if (!pidAlive(Number(readFileSync(join(dir, file), 'utf8').trim()))) continue;
      const repo = match[1] ? decodeURIComponent(match[1]) : '';
      used[repo] = (used[repo] ?? 0) + 1;
    } catch {
      // Released between the listing and the read.
    }
  }
  return used;
}

export interface QueuedJob {
  kind: string;
  label: string;
  repo?: string;
  since: string;
}

export function readQueue(root = process.cwd()): QueuedJob[] {
  const dir = join(root, '.ronin-slots', 'waiting');
  if (!existsSync(dir)) return [];
  const queue: QueuedJob[] = [];
  for (const file of readdirSync(dir)) {
    try {
      const mark = JSON.parse(readFileSync(join(dir, file), 'utf8')) as QueuedJob & { pid: number };
      if (pidAlive(mark.pid)) queue.push({ kind: mark.kind, label: mark.label, ...(mark.repo ? { repo: mark.repo } : {}), since: mark.since });
    } catch {
      // Cleared between the listing and the read.
    }
  }
  return queue.sort((a, b) => a.since.localeCompare(b.since));
}

const TAIL_BYTES = 2 * 1024 * 1024;

function tail(path: string): string {
  const { size } = statSync(path);
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

export interface TickInfo {
  lastTickAt?: string;
  lastTickDurationMs?: number;
  lastEventAt?: string;
}

// From the metrics the tick and the event handlers write to the daily log
// (tick.ts): the last tick_complete and the last event_complete, today's or
// yesterday's.
export function readTickInfo(now = new Date(), dir = logsDir()): TickInfo {
  const info: TickInfo = {};
  for (const day of [localDay(now), localDay(new Date(now.getTime() - 24 * 60 * 60 * 1000))]) {
    const path = join(dir, `tick-${day}.log`);
    if (!existsSync(path)) continue;
    for (const line of tail(path).split('\n').reverse()) {
      if (!line.startsWith('{"event":"')) continue;
      if (!info.lastTickAt && line.startsWith('{"event":"tick_complete"')) {
        try {
          const metric = JSON.parse(line) as { ts: string; durationMs: number };
          info.lastTickAt = metric.ts;
          info.lastTickDurationMs = metric.durationMs;
        } catch {
          // Cut by the tail's start.
        }
      } else if (!info.lastEventAt && line.startsWith('{"event":"event_complete"')) {
        try {
          info.lastEventAt = (JSON.parse(line) as { ts: string }).ts;
        } catch {
          // Cut by the tail's start.
        }
      }
      if (info.lastTickAt && info.lastEventAt) return info;
    }
  }
  return info;
}

// How loaded the runner's machine is, for the status bar: CPU used since the
// last read (every core together, 0–1) and the memory in use (0–1). The
// first read, or one after a long while, has no interval to measure, so its
// CPU is the last minute's load average over the cores instead.
export interface HostLoad {
  cpu: number;
  ram: number;
  cores: number;
  load: number[];
  memUsedBytes: number;
  memTotalBytes: number;
}

const CPU_SAMPLE_MAX_AGE_MS = 5 * 60_000;
let lastCpu: { at: number; idle: number; total: number } | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// MemAvailable, not MemFree: on Linux the page cache counts as free memory
// the kernel gives back, and os.freemem() leaves it out.
function memAvailable(meminfo = '/proc/meminfo'): number {
  try {
    const kb = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync(meminfo, 'utf8'));
    if (kb) return Number(kb[1]) * 1024;
  } catch {
    // Not Linux: what node knows.
  }
  return freemem();
}

export function hostLoad(now = Date.now(), meminfo?: string): HostLoad {
  const cores = cpus().length || 1;
  const load = loadavg();
  const times = cpuTimes();
  let cpu = Math.min(1, load[0] / cores);
  if (lastCpu && now - lastCpu.at <= CPU_SAMPLE_MAX_AGE_MS && times.total > lastCpu.total) {
    cpu = 1 - (times.idle - lastCpu.idle) / (times.total - lastCpu.total);
  }
  lastCpu = { at: now, ...times };
  const total = totalmem();
  const used = Math.max(0, total - memAvailable(meminfo));
  return { cpu: Math.max(0, Math.min(1, cpu)), ram: total ? used / total : 0, cores, load: load.map((n) => Math.round(n * 100) / 100), memUsedBytes: used, memTotalBytes: total };
}
