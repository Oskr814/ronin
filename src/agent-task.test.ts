import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: {
    playwrightTestResultsDir: 'apps/webapp/test-results',
    worktreeBaseRef: 'origin/main',
  },
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));

const ensureWorktree = vi.fn();
const remoteBranchExists = vi.fn();
vi.mock('./worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  remoteBranchExists: (...args: unknown[]) => remoteBranchExists(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('./claude-runner.js', () => ({
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const getPullRequestStatus = vi.fn();
vi.mock('./github.js', () => ({
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
}));

const rm = vi.fn();
vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => rm(...args),
}));

const { runAgentTask, AGENT_NOTES_REMINDER } = await import('./agent-task.js');
const { resetTickMetrics, getTickAgentMetrics } = await import('./metrics.js');

beforeEach(() => {
  vi.clearAllMocks();
  ensureWorktree.mockResolvedValue('/tmp/worktree');
  runClaudeHeadless.mockResolvedValue(undefined);
  getPullRequestStatus.mockResolvedValue({ headRefName: 'ronin/228/slice-1' });
  rm.mockResolvedValue(undefined);
});

describe('runAgentTask — review-request', () => {
  const task = {
    type: 'review-request' as const,
    issueNumber: 228,
    prNumber: 229,
    mentions: [{ id: 1, kind: 'issue' as const, body: '@ronin corré los e2e y dejá evidencia', reactionsEyes: 0 }],
  };

  it('clears test-results/ before invoking the headless run', async () => {
    await runAgentTask(task);

    expect(rm).toHaveBeenCalledWith('/tmp/worktree/apps/webapp/test-results', { recursive: true, force: true });
    const rmOrder = rm.mock.invocationCallOrder[0];
    const headlessOrder = runClaudeHeadless.mock.invocationCallOrder[0];
    expect(rmOrder).toBeLessThan(headlessOrder);
  });

  it('includes the conditional e2e-evidence instruction in the prompt', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('pnpm --filter @bmedical/webapp exec playwright test');
    expect(prompt).toContain('do not run the e2e suite');
  });
});

describe('runAgentTask — other task types leave test-results/ untouched', () => {
  it('does not clear test-results/ for fix-review', async () => {
    await runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 });

    expect(rm).not.toHaveBeenCalled();
  });
});

describe('runAgentTask — agent-run metrics', () => {
  beforeEach(() => {
    resetTickMetrics();
  });

  it('records a run on success', async () => {
    await runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 });

    expect(getTickAgentMetrics().agentRuns).toBe(1);
  });

  it('still records a run when the headless call fails', async () => {
    runClaudeHeadless.mockRejectedValueOnce(new Error('boom'));

    await expect(runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 })).rejects.toThrow('boom');

    expect(getTickAgentMetrics().agentRuns).toBe(1);
  });
});

describe('runAgentTask — agent-notes reminder', () => {
  it('is included for implement-slice', async () => {
    await runAgentTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for fix-bug', async () => {
    await runAgentTask({ type: 'fix-bug', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for fix-review', async () => {
    await runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for fix-e2e', async () => {
    await runAgentTask({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for fix-rebase', async () => {
    await runAgentTask({ type: 'fix-rebase', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for review-request', async () => {
    await runAgentTask({
      type: 'review-request',
      issueNumber: 228,
      prNumber: 229,
      mentions: [{ id: 1, kind: 'issue' as const, body: 'test', reactionsEyes: 0 }],
    });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is NOT included for plan', async () => {
    await runAgentTask({ type: 'plan', issueNumber: 228, specPaths: ['docs/superpowers/specs/foo.md'] });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).not.toContain(AGENT_NOTES_REMINDER);
  });
});
