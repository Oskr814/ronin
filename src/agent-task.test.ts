import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: {
    playwrightTestResultsDir: 'apps/webapp/test-results',
    worktreeBaseRef: 'origin/main',
    productRepo: 'bmedical/bmedical',
  },
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

const { runAgentTask } = await import('./agent-task.js');

beforeEach(() => {
  vi.clearAllMocks();
  ensureWorktree.mockResolvedValue('/tmp/worktree');
  runClaudeHeadless.mockResolvedValue(undefined);
  getPullRequestStatus.mockResolvedValue({ headRefName: 'valeria/228/slice-1' });
  rm.mockResolvedValue(undefined);
});

describe('runAgentTask — review-request', () => {
  const task = {
    type: 'review-request' as const,
    issueNumber: 228,
    prNumber: 229,
    mentions: [{ id: 1, kind: 'issue' as const, body: '@valeria-agent corré los e2e y dejá evidencia', reactionsEyes: 0 }],
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
