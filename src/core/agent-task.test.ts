import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentTask, PreparedTask } from './agent-task.js';

vi.mock('./config.js', () => ({
  config: { worktreeBaseRef: 'origin/main' },
  agentModelFor: (taskType: string) => `model-for-${taskType}`,
  agentEffortFor: (taskType: string) => `effort-for-${taskType}`,
}));

const activeRepo = vi.fn();
vi.mock('./repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const ensureWorktree = vi.fn();
const ensureExternalReviewWorktree = vi.fn();
const removeExternalReviewWorktree = vi.fn();
const ensureTrustedFixWorktree = vi.fn();
const removeTrustedFixWorktree = vi.fn();
vi.mock('./worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  ensureExternalReviewWorktree: (...args: unknown[]) => ensureExternalReviewWorktree(...args),
  removeExternalReviewWorktree: (...args: unknown[]) => removeExternalReviewWorktree(...args),
  ensureTrustedFixWorktree: (...args: unknown[]) => ensureTrustedFixWorktree(...args),
  removeTrustedFixWorktree: (...args: unknown[]) => removeTrustedFixWorktree(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('./claude-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-runner.js')>()),
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const rm = vi.fn();
const writeFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => rm(...args),
  writeFile: (...args: unknown[]) => writeFile(...args),
}));

const { runAgentTask } = await import('./agent-task.js');
const { resetTickMetrics, getTickAgentMetrics } = await import('./metrics.js');

// A task as a feature's prompts.ts hands it over, with what it prepares
// given verbatim.
function task(fields: Omit<AgentTask, 'prepare'>, prepared: Partial<PreparedTask> = {}): AgentTask {
  return { ...fields, prepare: async () => ({ branch: 'ronin/228/slice-1', prompt: 'the prompt', checkout: { kind: 'branch' }, ...prepared }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' });
  ensureWorktree.mockResolvedValue('/tmp/worktree');
  ensureExternalReviewWorktree.mockResolvedValue('/tmp/worktree');
  removeExternalReviewWorktree.mockResolvedValue(undefined);
  ensureTrustedFixWorktree.mockResolvedValue('/tmp/worktree');
  removeTrustedFixWorktree.mockResolvedValue(undefined);
  runClaudeHeadless.mockResolvedValue(undefined);
  rm.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
});

describe('runAgentTask — checkout', () => {
  it('runs on a ronin worktree of its branch, from the base branch it gives', async () => {
    await runAgentTask(task({ type: 'implement-slice', issueNumber: 228 }, { checkout: { kind: 'branch', baseBranch: 'origin/odoo-main' } }));

    expect(ensureWorktree).toHaveBeenCalledWith('ronin/228/slice-1', 'origin/odoo-main');
    expect(runClaudeHeadless.mock.calls[0][0]).toBe('/tmp/worktree');
    expect(runClaudeHeadless.mock.calls[0][1]).toBe('the prompt');
  });

  it('runs in a checkout the caller already set up, or one a function brings up to date', async () => {
    await runAgentTask(task({ type: 'prototype', issueNumber: 1 }, { checkout: { kind: 'dir', dir: '/tmp/prototype' } }));
    expect(runClaudeHeadless.mock.calls[0][0]).toBe('/tmp/prototype');

    await runAgentTask(task({ type: 'update-changelog' }, { checkout: { kind: 'dir', dir: async () => '/tmp/changelog' } }));
    expect(runClaudeHeadless.mock.calls[1][0]).toBe('/tmp/changelog');
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it('returns runClaudeHeadless\'s result so the caller can read the RONIN_STATUS marker', async () => {
    runClaudeHeadless.mockResolvedValueOnce('Opened PR #42.\nRONIN_STATUS: done');

    expect(await runAgentTask(task({ type: 'fix-issue', issueNumber: 228 }))).toBe('Opened PR #42.\nRONIN_STATUS: done');
  });

  it('hands claude -p the MCP config it gives', async () => {
    await runAgentTask(task({ type: 'prototype', issueNumber: 1 }, { checkout: { kind: 'dir', dir: '/tmp/w' }, mcpConfigFile: '/tmp/mcp.json' }));

    expect(runClaudeHeadless.mock.calls[0][3]).toMatchObject({ mcpConfigFile: '/tmp/mcp.json' });
  });
});

describe('runAgentTask — an untrusted PR head', () => {
  const review = (prepared: Partial<PreparedTask> = {}) => task({ type: 'external-review', prNumber: 305 }, {
    branch: 'detached@abc123',
    checkout: { kind: 'untrusted-pr-head', prNumber: 305, sha: 'abc123' },
    agents: { path: '/tmp/worktrees/external-review-out/305-abc123.agents.json', definitions: { 'review-security': { description: 'Seguridad', prompt: 'p', tools: ['Read'] } } },
    ...prepared,
  });

  it('checks the PR head out by SHA, never by branch name', async () => {
    await runAgentTask(review());

    expect(ensureExternalReviewWorktree).toHaveBeenCalledWith(305, 'abc123');
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it('removes the worktree-local .claude/ and CLAUDE.md before the headless run', async () => {
    await runAgentTask(review());

    expect(rm).toHaveBeenCalledWith('/tmp/worktree/.claude', { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith('/tmp/worktree/CLAUDE.md', { recursive: true, force: true });
    const worktreeRms = rm.mock.invocationCallOrder.filter((_, i) => String(rm.mock.calls[i][0]).startsWith('/tmp/worktree/'));
    const lastRmOrder = Math.max(...worktreeRms);
    expect(lastRmOrder).toBeLessThan(runClaudeHeadless.mock.invocationCallOrder[0]);
  });

  it('writes the workers to the --agents file, and removes it after the run', async () => {
    await runAgentTask(review());

    const [path, json] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('/tmp/worktrees/external-review-out/305-abc123.agents.json');
    expect(Object.keys(JSON.parse(json))).toEqual(['review-security']);
    expect(runClaudeHeadless.mock.calls[0][3]).toMatchObject({ agentsFile: path });
    expect(rm).toHaveBeenCalledWith(path, { force: true });
  });

  it('removes the worktree after a successful run', async () => {
    await runAgentTask(review());

    expect(removeExternalReviewWorktree).toHaveBeenCalledWith(305);
  });

  it('removes the worktree after a failed run, without masking the error', async () => {
    runClaudeHeadless.mockRejectedValueOnce(new Error('boom'));

    await expect(runAgentTask(review())).rejects.toThrow('boom');

    expect(removeExternalReviewWorktree).toHaveBeenCalledWith(305);
  });

  it('does not fail the task when cleanup itself fails', async () => {
    removeExternalReviewWorktree.mockRejectedValueOnce(new Error('cleanup exploded'));

    await expect(runAgentTask(review())).resolves.toBeUndefined();
  });

  it('removes nothing for any other checkout', async () => {
    await runAgentTask(task({ type: 'fix-review', issueNumber: 228, prNumber: 229 }));

    expect(removeExternalReviewWorktree).not.toHaveBeenCalled();
    expect(removeTrustedFixWorktree).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });
});

describe('runAgentTask — a human\'s branch', () => {
  // Not a plain ensureWorktree checkout: this branch is a trusted human's
  // own, routinely checked out in the primary worktree at the same time
  // (reproduced live on PR #336) — a plain branch checkout would collide
  // with that, so this uses the detached ensureTrustedFixWorktree instead,
  // same fix class as the untrusted head's SHA-based checkout above.
  const fix = () => task({ type: 'fix-comments-external', prNumber: 599 }, { branch: 'feat/cambio-cliente-pedido-creado', checkout: { kind: 'human-branch' } });

  it('checks out the detached trusted-fix worktree by branch name, never a plain or external-review one', async () => {
    await runAgentTask(fix());

    expect(ensureTrustedFixWorktree).toHaveBeenCalledWith('feat/cambio-cliente-pedido-creado');
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(ensureExternalReviewWorktree).not.toHaveBeenCalled();
  });

  it('does not strip .claude or CLAUDE.md from the worktree', async () => {
    await runAgentTask(fix());

    expect(rm).not.toHaveBeenCalled();
  });

  it('removes the trusted-fix worktree after a successful run', async () => {
    await runAgentTask(fix());

    expect(removeTrustedFixWorktree).toHaveBeenCalledWith('feat/cambio-cliente-pedido-creado');
  });

  it('removes the trusted-fix worktree after a failed run, without masking the error', async () => {
    runClaudeHeadless.mockRejectedValueOnce(new Error('boom'));

    await expect(runAgentTask(fix())).rejects.toThrow('boom');

    expect(removeTrustedFixWorktree).toHaveBeenCalledWith('feat/cambio-cliente-pedido-creado');
  });

  it('does not fail the task when trusted-fix cleanup itself fails', async () => {
    removeTrustedFixWorktree.mockRejectedValueOnce(new Error('cleanup exploded'));

    await expect(runAgentTask(fix())).resolves.toBeUndefined();
  });
});

describe('runAgentTask — agent-run metrics', () => {
  beforeEach(() => {
    resetTickMetrics();
  });

  it('records a run on success', async () => {
    await runAgentTask(task({ type: 'fix-review', issueNumber: 228, prNumber: 229 }));

    expect(getTickAgentMetrics().agentRuns).toBe(1);
  });

  it('still records a run when the headless call fails', async () => {
    runClaudeHeadless.mockRejectedValueOnce(new Error('boom'));

    await expect(runAgentTask(task({ type: 'fix-review', issueNumber: 228, prNumber: 229 }))).rejects.toThrow('boom');

    expect(getTickAgentMetrics().agentRuns).toBe(1);
  });

  it('records a run for a task with no issueNumber field', async () => {
    await runAgentTask(task({ type: 'external-review', prNumber: 305 }, { checkout: { kind: 'untrusted-pr-head', prNumber: 305, sha: 'abc123' } }));

    expect(getTickAgentMetrics().agentRuns).toBe(1);
  });
});

describe('runAgentTask — model and effort per task type', () => {
  it("runs each task on its own type's model and effort", async () => {
    await runAgentTask(task({ type: 'fix-review', issueNumber: 1, prNumber: 2 }));
    expect(runClaudeHeadless.mock.calls[0][3]).toEqual({ model: 'model-for-fix-review', effort: 'effort-for-fix-review' });
  });
});

describe('runAgentTask — names', () => {
  it('names the run after its issue, then its PR, unless the task gives a label and a tag', async () => {
    await runAgentTask(task({ type: 'review-request', issueNumber: 228, prNumber: 229 }));
    await runAgentTask(task({ type: 'external-review', prNumber: 305 }));
    await runAgentTask(task({ type: 'portal-request', requestNumber: 31 }, { label: 'pedido P-31', tag: 'P-31' }));

    expect(runClaudeHeadless.mock.calls.map((call) => call[2])).toEqual(['review-request #228', 'external-review #305', 'portal-request #P-31']);
  });
});

describe('runAgentTask — run record', () => {
  // The record runAgentTask handed to its last runClaudeHeadless call.
  async function lastRecord(): Promise<any[]> {
    const { readFileSync } = await import('node:fs');
    const record = runClaudeHeadless.mock.calls.at(-1)![4] as { path: string };
    return readFileSync(record.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }
  const slice = () => task({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

  it('records the run, hands it to runClaudeHeadless, and closes it as ok', async () => {
    await runAgentTask(slice());

    const lines = await lastRecord();
    expect(lines[0]).toMatchObject({
      type: 'run_start', repo: 'bmedical/bmedical', taskType: 'implement-slice', label: 'issue #228', issueNumber: 228,
      sliceIndex: 0, sliceTitle: 'Add foo', model: 'model-for-implement-slice', worktree: '/tmp/worktree',
    });
    expect(lines.at(-1)).toMatchObject({ type: 'run_end', outcome: 'ok' });
    expect(runClaudeHeadless.mock.calls[0][4]).toHaveProperty('runId', lines[0].runId);
  });

  it('names the portal request it belongs to', async () => {
    await runAgentTask(task({ type: 'portal-request', requestNumber: 31 }, { label: 'pedido P-31' }));

    expect((await lastRecord())[0]).toMatchObject({ label: 'pedido P-31', portalRequest: 31 });
  });

  it('closes it with the kind of failure', async () => {
    const { ClaudeTimeoutError, ClaudeUsageLimitError } = await import('./claude-runner.js');
    for (const [error, outcome] of [[new ClaudeTimeoutError('t'), 'timeout'], [new ClaudeUsageLimitError('u'), 'usage_limit'], [new Error('boom'), 'error']] as const) {
      runClaudeHeadless.mockRejectedValueOnce(error);
      await expect(runAgentTask(slice())).rejects.toBe(error);
      expect((await lastRecord()).at(-1)).toMatchObject({ type: 'run_end', outcome });
    }
  });
});
