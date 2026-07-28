// Deliberately unimplemented: spawning `claude -p` inside an isolated git
// worktree, constructing the prompt from issue/PR state, and parsing the
// result back into a slice/PR needs its own design pass (worktree lifecycle,
// prompt shape, timeout/retry policy). Everything upstream (github.ts,
// specs.ts, tick.ts) is wired to call this interface so that pass can slot in
// without touching the rest of the supervisor.

export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPath: string }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number };

export async function runAgentTask(task: AgentTask): Promise<void> {
  throw new Error(`runAgentTask not implemented yet (task: ${task.type}, issue #${task.issueNumber})`);
}
