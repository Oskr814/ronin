import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorktree, ensureExternalReviewWorktree, removeExternalReviewWorktree, ensureTrustedFixWorktree, removeTrustedFixWorktree } from '../git/worktree.js';
import { runClaudeHeadless, ClaudeTimeoutError, ClaudeUsageLimitError } from '../claude/claude-runner.js';
import { accountName } from '../claude/claude-usage.js';
import { RunRecord, type RunOutcome } from './run-record.js';
import { config, agentModelFor, agentEffortFor } from '../config/config.js';
import { activeRepo } from './repo-context.js';
import { log } from '../logger.js';
import { recordAgentRun } from './metrics.js';
import { currentRunGroup } from './run-group.js';

// The mechanics every agent run shares: the checkout it runs in, `claude -p`
// with its type's model and effort, the run record, metrics and cleanup.
// What the agent is told is each feature's business: its prompts.ts turns
// its own task types into an AgentTask (see platform/agents/prompts.ts for the rules
// they share), and nothing here knows about any of them.

// Where a run happens.
export type TaskCheckout =
  // A ronin worktree on the task's branch, created from baseBranch when the
  // branch doesn't exist yet (worktree.ts's ensureWorktree).
  | { kind: 'branch'; baseBranch?: string }
  // A checkout the caller already set up and owns, or a function that
  // brings one up to date and returns it.
  | { kind: 'dir'; dir: string | (() => Promise<string>) }
  // The head of a PR someone else opened, by SHA, never by branch name: a
  // fork's head branch may not exist in this repo at all (or may collide
  // with a local ref, including the primary worktree's own `main`), and a
  // re-review must always see the PR's current head — see final review
  // Fix 1. Its code is untrusted, so the run strips the project config
  // Claude Code would load from it, and the checkout goes once it ends.
  | { kind: 'untrusted-pr-head'; prNumber: number; sha: string }
  // A trusted human's own same-repo branch, detached: it's routinely
  // checked out in the primary worktree at the same time (the human who
  // asked is often the one actively developing it there), and a plain
  // branch checkout would collide with that, same class of failure as the
  // fork case above — see ensureTrustedFixWorktree. Removed once it ends.
  | { kind: 'human-branch' };

// A subagent the run can launch, in `claude --agents` format.
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
}

export interface PreparedTask {
  // The branch the task works on; for a checkout that isn't a ronin
  // worktree of its own, only a label for the log.
  branch: string;
  prompt: string;
  checkout: TaskCheckout;
  // How the log, the run record and the runner name the run when it isn't
  // the task's issue or PR: "pedido P-3", "app backoffice".
  label?: string;
  tag?: string | number;
  // Written to `path` for `claude --agents`, and removed after the run.
  agents?: { path: string; definitions: Record<string, AgentDefinition> };
  mcpConfigFile?: string;
}

export interface AgentTask {
  // Picks the model and effort (config.ts's agentModelFor) and names the run
  // in the metrics and the dashboard.
  type: string;
  issueNumber?: number;
  prNumber?: number;
  requestNumber?: number;
  meetingNumber?: number;
  sliceIndex?: number;
  sliceTitle?: string;
  // Builds the prompt and says where it runs; called once, first thing.
  prepare(): Promise<PreparedTask>;
}

function runOutcome(error: unknown): RunOutcome {
  if (error instanceof ClaudeUsageLimitError) return 'usage_limit';
  if (error instanceof ClaudeTimeoutError) return 'timeout';
  return 'error';
}

async function checkoutDir(checkout: TaskCheckout, branch: string): Promise<string> {
  switch (checkout.kind) {
    case 'branch': return ensureWorktree(branch, checkout.baseBranch);
    case 'dir': return typeof checkout.dir === 'string' ? checkout.dir : checkout.dir();
    case 'untrusted-pr-head': return ensureExternalReviewWorktree(checkout.prNumber, checkout.sha);
    case 'human-branch': return ensureTrustedFixWorktree(branch);
  }
}

export async function runAgentTask(task: AgentTask): Promise<string> {
  const { branch, prompt, checkout, agents, mcpConfigFile, ...prepared } = await task.prepare();
  const worktreeDir = await checkoutDir(checkout, branch);

  // An untrusted PR head is the only checkout that points `claude -p
  // --permission-mode bypassPermissions` at a tree an arbitrary external
  // contributor controls. Claude Code auto-loads project config from its cwd
  // (CLAUDE.md, .claude/settings.json hooks, skills), so a malicious PR could
  // otherwise get code execution on this host before the model reads a single
  // line of the diff. Removing both surfaces is blunt but effective.
  // Known follow-up, deliberately NOT attempted here: running this task type
  // under a restricted permission mode / explicit tool allowlist instead of
  // bypassPermissions, which needs a new parameter plumbed through
  // runClaudeHeadless (shared by every other task type).
  if (checkout.kind === 'untrusted-pr-head') {
    await rm(join(worktreeDir, '.claude'), { recursive: true, force: true });
    await rm(join(worktreeDir, 'CLAUDE.md'), { recursive: true, force: true });
  }

  // A file rather than inline JSON: with every worker's criteria it's tens of
  // KB, too much for one argv entry to be comfortable.
  const agentsFile = agents?.path;
  if (agents) await writeFile(agents.path, JSON.stringify(agents.definitions));

  const issueNumber = task.issueNumber;
  const prNumber = task.prNumber;
  const label = prepared.label ?? (issueNumber !== undefined ? `issue #${issueNumber}` : `PR #${prNumber}`);
  const tag = prepared.tag ?? issueNumber ?? prNumber;
  log.info(`starting ${task.type} for ${label} on branch ${branch}`);
  const start = Date.now();
  const model = agentModelFor(task.type);
  const effort = agentEffortFor(task.type);
  const group = currentRunGroup();
  // The run's own record, for the dashboard (run-record.ts).
  const record = RunRecord.start({
    repo: activeRepo().productRepo,
    taskType: task.type,
    label,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(task.requestNumber !== undefined ? { portalRequest: task.requestNumber } : {}),
    ...(task.meetingNumber !== undefined ? { meeting: task.meetingNumber } : {}),
    ...(task.sliceIndex !== undefined ? { sliceIndex: task.sliceIndex, sliceTitle: task.sliceTitle } : {}),
    ...(group ? { group } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    account: accountName(activeRepo().claudeConfigDir ?? config.claudeConfigDir ?? ''),
    worktree: worktreeDir,
  });
  try {
    const result = await runClaudeHeadless(worktreeDir, prompt, `${task.type} #${tag}`, {
      model,
      effort,
      ...(agentsFile ? { agentsFile } : {}),
      ...(mcpConfigFile ? { mcpConfigFile } : {}),
    }, record);
    const durationMs = Date.now() - start;
    recordAgentRun(durationMs);
    log.metric('agent_run', { taskType: task.type, issueNumber, prNumber, durationMs, success: true });
    await record.end('ok');
    log.info(`finished ${task.type} for ${label}`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    recordAgentRun(durationMs);
    log.metric('agent_run', { taskType: task.type, issueNumber, prNumber, durationMs, success: false });
    await record.end(runOutcome(error), error);
    log.error(`${task.type} for ${label} failed`, error);
    throw error;
  } finally {
    // Success or failure, this checkout has no reason to survive the run —
    // nothing retries against it (the next tick re-fetches the PR's head
    // from scratch), so leaving it behind would just pile up one stale
    // detached worktree per external PR ever reviewed. Best-effort and
    // fully swallowed: a cleanup failure must never mask the real error nor
    // turn a successful review into a failed task.
    if (agentsFile) await rm(agentsFile, { force: true }).catch(() => {});
    if (checkout.kind === 'untrusted-pr-head') {
      await removeExternalReviewWorktree(checkout.prNumber).catch((cleanupError) =>
        log.error(`${task.type} cleanup falló para PR #${checkout.prNumber}`, cleanupError),
      );
    }
    // Same reasoning as the untrusted head's cleanup above: nothing retries
    // against this checkout (the next tick re-fetches the branch's current
    // head from scratch), and — unlike ensureWorktree's own ronin/<issue>/…
    // branches — sweepOrphanedWorktrees never recognizes a human branch name
    // as its own, so a leftover here would never get swept.
    if (checkout.kind === 'human-branch') {
      await removeTrustedFixWorktree(branch).catch((cleanupError) =>
        log.error(`${task.type} cleanup falló para PR #${prNumber}`, cleanupError),
      );
    }
  }
}
