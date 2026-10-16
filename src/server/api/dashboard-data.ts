import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir, localDay } from '../../core/run-files.js';
import type { AccountUsage } from '../../core/claude-usage.js';
import type { RunOutcome } from '../../core/run-record.js';

// What the dashboard reads from this runner's own files (#65): the per-run
// records (logs/runs/), each account's usage (logs/usage/), the agent slots
// and what waits for one (.ronin-slots/), and the tick log's metrics. All of
// it local: what needs GitHub (titles, slices, labels) comes later.

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type RunState = 'running' | 'cut' | RunOutcome;

export interface RunLine {
  type: string;
  [key: string]: unknown;
}

export interface RunSummary {
  runId: string;
  repo: string;
  taskType: string;
  label: string;
  issueNumber?: number;
  prNumber?: number;
  sliceIndex?: number;
  sliceTitle?: string;
  model?: string;
  effort?: string;
  account: string;
  worktree: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
  state: RunState;
  steps: number;
  lastStep?: string;
}

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

function stepText(line: RunLine): string {
  // A command reads as itself ("$ pnpm test"); anything else, with its tool.
  if (line.type === 'tool') return line.name === 'Bash' ? String(line.summary) : `${line.name}: ${line.summary}`;
  return String(line.text ?? '');
}

export function summarizeRun(lines: RunLine[]): RunSummary | null {
  const start = lines[0];
  if (start?.type !== 'run_start') return null;
  const end = lines.find((line) => line.type === 'run_end');
  const steps = lines.filter((line) => line.type === 'text' || line.type === 'tool' || line.type === 'tool_error');
  const last = steps.at(-1);
  const pick = <T>(key: string) => (start[key] as T | undefined);
  return {
    runId: String(start.runId),
    repo: String(start.repo),
    taskType: String(start.taskType),
    label: String(start.label ?? ''),
    ...(pick<number>('issueNumber') !== undefined ? { issueNumber: pick<number>('issueNumber') } : {}),
    ...(pick<number>('prNumber') !== undefined ? { prNumber: pick<number>('prNumber') } : {}),
    ...(pick<number>('sliceIndex') !== undefined ? { sliceIndex: pick<number>('sliceIndex'), sliceTitle: pick<string>('sliceTitle') } : {}),
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

export function listRuns(days: number, now = new Date()): RunSummary[] {
  const root = join(logsDir(), 'runs');
  if (!existsSync(root)) return [];
  const wanted = new Set(Array.from({ length: days }, (_, i) => localDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000))));
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

export interface Item {
  id: string;
  repo: string;
  number?: number;
  kind: 'issue' | 'pr' | 'other';
  title: string;
  state: RunState;
  lastRun: RunSummary;
  runs: number;
}

function itemTitle(run: RunSummary): string {
  if (run.sliceTitle) return run.sliceTitle;
  if (run.issueNumber !== undefined) return `Issue #${run.issueNumber}`;
  if (run.prNumber !== undefined) return `PR #${run.prNumber}`;
  return run.label;
}

// Most recent activity first; what's running at the top.
export function groupItems(runs: RunSummary[]): Item[] {
  const items = new Map<string, Item>();
  for (const run of runs) {
    const id = itemKey(run);
    const item = items.get(id);
    if (item) {
      item.runs += 1;
      if (run.state === 'running') item.state = 'running';
      continue;
    }
    items.set(id, {
      id,
      repo: run.repo,
      ...(run.issueNumber ?? run.prNumber) !== undefined ? { number: run.issueNumber ?? run.prNumber } : {},
      kind: run.issueNumber !== undefined ? 'issue' : run.prNumber !== undefined ? 'pr' : 'other',
      title: itemTitle(run),
      state: run.state,
      lastRun: run,
      runs: 1,
    });
  }
  return [...items.values()].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastRun.startedAt.localeCompare(a.lastRun.startedAt));
}

export function readUsage(): AccountUsage[] {
  const dir = join(logsDir(), 'usage');
  if (!existsSync(dir)) return [];
  const usage: AccountUsage[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      usage.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as AccountUsage);
    } catch {
      // Being replaced right now; the next read has it.
    }
  }
  return usage.sort((a, b) => a.account.localeCompare(b.account));
}

// The runner-wide agent slots (core/locks.ts): one lock file per slot taken,
// holding its process's pid.
export function slotsInUse(root = process.cwd()): number {
  const dir = join(root, '.ronin-slots');
  if (!existsSync(dir)) return 0;
  let used = 0;
  for (const file of readdirSync(dir)) {
    if (!/^all-\d+\.lock$/.test(file)) continue;
    try {
      if (pidAlive(Number(readFileSync(join(dir, file), 'utf8').trim()))) used += 1;
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
