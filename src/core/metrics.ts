import { activeRepo } from './repo-context.js';

// Per-tick accumulator for agent-run time — reset at the start of every
// repo's tick (see tick.ts), fed by agent-task.ts's runAgentTask, read back at
// its end to log how much of the tick was spent waiting on `claude -p` runs
// vs. everything else (GitHub API calls, bookkeeping). Kept per repo: the
// cron tick runs every repo at once.
const metrics = new Map<string, { agentRuns: number; agentRunsDurationMs: number }>();
const key = () => {
  try {
    return activeRepo().productRepo;
  } catch {
    return '';
  }
};

export function resetTickMetrics(): void {
  metrics.set(key(), { agentRuns: 0, agentRunsDurationMs: 0 });
}

export function recordAgentRun(durationMs: number): void {
  const current = metrics.get(key()) ?? { agentRuns: 0, agentRunsDurationMs: 0 };
  current.agentRuns += 1;
  current.agentRunsDurationMs += durationMs;
  metrics.set(key(), current);
}

export function getTickAgentMetrics(): { agentRuns: number; agentRunsDurationMs: number } {
  return { ...(metrics.get(key()) ?? { agentRuns: 0, agentRunsDurationMs: 0 }) };
}
