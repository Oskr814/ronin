// Per-tick accumulator for agent-run time — reset at the start of every
// tick() (see tick.ts), fed by agent-task.ts's runAgentTask, read back at
// the end of tick() to log how much of the tick was spent waiting on
// sequential `claude -p` runs vs. everything else (GitHub API calls,
// bookkeeping). That ratio is the data needed to tell whether parallelizing
// agent runs across issues is actually worth doing.
let agentRuns = 0;
let agentRunsDurationMs = 0;

export function resetTickMetrics(): void {
  agentRuns = 0;
  agentRunsDurationMs = 0;
}

export function recordAgentRun(durationMs: number): void {
  agentRuns += 1;
  agentRunsDurationMs += durationMs;
}

export function getTickAgentMetrics(): { agentRuns: number; agentRunsDurationMs: number } {
  return { agentRuns, agentRunsDurationMs };
}
