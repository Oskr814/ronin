import { localDay } from '../../core/run-files.js';
import { itemKey, type RunState, type RunSummary } from './dashboard-data.js';

// The dashboard's "Hoy" (#65): every run of the last hours, for the
// timeline, and the day's totals. From the per-run records only.

export const TIMELINE_HOURS = 12;

export interface TimelineRun {
  runId: string;
  repo: string;
  itemId: string;
  taskType: string;
  startedAt: string;
  endedAt?: string;
  state: RunState;
}

export interface DayTotals {
  runs: number;
  finished: number;
  ok: number;
  failed: number;
  usageLimit: number;
  medianMs: number | null;
  p90Ms: number | null;
  costUsd: number;
}

export interface Today {
  from: string;
  to: string;
  timeline: TimelineRun[];
  today: DayTotals;
  yesterday: Pick<DayTotals, 'runs' | 'ok' | 'finished'>;
}

const FAILED: RunState[] = ['error', 'timeout', 'cut'];

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function dayTotals(runs: RunSummary[]): DayTotals {
  const finished = runs.filter((run) => run.state !== 'running');
  const durations = finished.flatMap((run) => (run.durationMs !== undefined ? [run.durationMs] : [])).sort((a, b) => a - b);
  return {
    runs: runs.length,
    finished: finished.length,
    ok: finished.filter((run) => run.state === 'ok').length,
    failed: finished.filter((run) => FAILED.includes(run.state)).length,
    usageLimit: finished.filter((run) => run.state === 'usage_limit').length,
    medianMs: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  };
}

// `runs`: today's and yesterday's at least (listRuns(2)).
export function today(runs: RunSummary[], now = new Date()): Today {
  const from = new Date(now.getTime() - TIMELINE_HOURS * 60 * 60 * 1000);
  const day = localDay(now);
  const yesterdayDay = localDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const startedOn = (d: string) => runs.filter((run) => localDay(new Date(run.startedAt)) === d);
  const yesterday = dayTotals(startedOn(yesterdayDay));
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    timeline: runs
      .filter((run) => run.state === 'running' || Date.parse(run.endedAt ?? run.startedAt) >= from.getTime())
      .map((run) => ({
        runId: run.runId,
        repo: run.repo,
        itemId: itemKey(run),
        taskType: run.taskType,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        state: run.state,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    today: dayTotals(startedOn(day)),
    yesterday: { runs: yesterday.runs, ok: yesterday.ok, finished: yesterday.finished },
  };
}
