import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_NOTES_REMINDER, COMMIT_STYLE_RULE, PR_BODY_RULE, PR_BODY_SECTIONS } from '@platform/agents/prompts.js';

vi.mock('@platform/config/config.js', () => ({
  config: {
    worktreeBaseRef: 'origin/main',
    externalReviewWorkerModel: 'sonnet',
    githubLogin: 'ronin-agent',
    specDir: 'docs/superpowers',
  },
  agentModelFor: (taskType: string) => `model-for-${taskType}`,
  agentEffortFor: (taskType: string) => `effort-for-${taskType}`,
  reviewWorkerModel: () => 'sonnet',
}));

const activeRepo = vi.fn();
vi.mock('@platform/agents/repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const ensureWorktree = vi.fn();
const remoteBranchExists = vi.fn();
const ensureExternalReviewWorktree = vi.fn();
const removeExternalReviewWorktree = vi.fn();
const ensureTrustedFixWorktree = vi.fn();
const removeTrustedFixWorktree = vi.fn();
vi.mock('@platform/git/worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  remoteBranchExists: (...args: unknown[]) => remoteBranchExists(...args),
  ensureExternalReviewWorktree: (...args: unknown[]) => ensureExternalReviewWorktree(...args),
  removeExternalReviewWorktree: (...args: unknown[]) => removeExternalReviewWorktree(...args),
  ensureTrustedFixWorktree: (...args: unknown[]) => ensureTrustedFixWorktree(...args),
  removeTrustedFixWorktree: (...args: unknown[]) => removeTrustedFixWorktree(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('@platform/claude/claude-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@platform/claude/claude-runner.js')>()),
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const getPullRequestStatus = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
}));

const rm = vi.fn();
const writeFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => rm(...args),
  writeFile: (...args: unknown[]) => writeFile(...args),
}));

const loadReviewCriteria = vi.fn();
vi.mock('../review/criteria.js', () => ({ loadReviewCriteria: (...args: unknown[]) => loadReviewCriteria(...args) }));

const { runAgentTask: run } = await import('@platform/agents/agent-task.js');
const { sliceTask } = await import('./prompts.js');
// Each task runs through the real runAgentTask, with its checkout and
// `claude -p` mocked: what a test reads is the prompt it was handed.
const runAgentTask = (task: Parameters<typeof sliceTask>[0]) => run(sliceTask(task));
const buildTask = (task: Parameters<typeof sliceTask>[0]) => sliceTask(task).prepare();

beforeEach(() => {
  loadReviewCriteria.mockResolvedValue({ text: '# Criterio\n## No marcar\n- sin constantes en migraciones', blobHash: 'h' });
  vi.clearAllMocks();
  activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' });
  ensureWorktree.mockResolvedValue('/tmp/worktree');
  ensureExternalReviewWorktree.mockResolvedValue('/tmp/worktree');
  removeExternalReviewWorktree.mockResolvedValue(undefined);
  ensureTrustedFixWorktree.mockResolvedValue('/tmp/worktree');
  removeTrustedFixWorktree.mockResolvedValue(undefined);
  runClaudeHeadless.mockResolvedValue(undefined);
  getPullRequestStatus.mockResolvedValue({ headRefName: 'ronin/228/slice-1' });
  rm.mockResolvedValue(undefined);
  writeFile.mockResolvedValue(undefined);
});

describe('sliceTask — per-repo worktreeBaseRef override', () => {
  it("uses the active repo's own worktreeBaseRef for a slice 0 worktree, not config's", async () => {
    activeRepo.mockReturnValue({
      productRepo: 'bmedical/bmedical',
      productRepoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      worktreeBaseRef: 'origin/odoo-main',
    });

    await runAgentTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

    expect(ensureWorktree).toHaveBeenCalledWith('ronin/228/slice-1', 'origin/odoo-main');
  });

  it("uses the active repo's own worktreeBaseRef as the fix-issue worktree base, not config's", async () => {
    activeRepo.mockReturnValue({
      productRepo: 'bmedical/bmedical',
      productRepoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      worktreeBaseRef: 'origin/odoo-main',
    });

    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    expect(ensureWorktree).toHaveBeenCalledWith('ronin/228/slice-1', 'origin/odoo-main');
  });
});

describe('runAgentTask — fix-issue prompt', () => {
  it('does not claim the issue is labeled bugfix and ends with the RONIN_STATUS marker instruction', async () => {
    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).not.toContain('labeled "bugfix"');
    expect(prompt).toContain('RONIN_STATUS: needs-info');
    expect(prompt).toContain('RONIN_STATUS: done');
  });

  it("asks to repeat the issue's images in the PR body instead of pointing to the issue", async () => {
    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('reusing the same image URLs');
    expect(prompt).toContain('never just say they are in the issue');
    expect(prompt).toContain('Leave out the "before" of an exploration finding');
    expect(prompt).toContain('/antes-<n>.<ext>');
  });

  it("starts an exploration finding's issue from the finding's diagnosis and draft, instead of from scratch", async () => {
    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('"ronin-ficha:" key');
    expect(prompt).toContain('Cambio borrador usado para el después');
    expect(prompt).toContain('Start from them instead of investigating from scratch');
    expect(prompt).toContain('without widening its scope');
  });

  it('returns runClaudeHeadless\'s result so the caller can read the RONIN_STATUS marker', async () => {
    runClaudeHeadless.mockResolvedValueOnce('Opened PR #42.\nRONIN_STATUS: done');

    const result = await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    expect(result).toBe('Opened PR #42.\nRONIN_STATUS: done');
  });
});

describe('runAgentTask — PR body sections', () => {
  it.each([
    ['implement-slice', 'Add foo'],
    ['fix-issue', 'Fix foo'],
  ] as const)('asks %s for the fixed sections instead of the repo\'s PR template', async (type, sliceTitle) => {
    await runAgentTask({ type, issueNumber: 228, sliceIndex: 0, sliceTitle });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(PR_BODY_RULE);
    for (const heading of PR_BODY_SECTIONS) expect(prompt).toContain(`"## ${heading}"`);
    expect(prompt).toContain('do not follow this repo\'s pull request template');
  });

  it('keeps "Closes #N" on the first line and the screenshots under "Qué cambió" for fix-issue', async () => {
    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('with "Closes #228" on the first line of the body');
    expect(prompt).toContain('put them in the PR body too, under "## Qué cambió"');
  });
});

describe('runAgentTask — agent-notes reminder', () => {
  it('is included for implement-slice', async () => {
    await runAgentTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(true);
  });

  it('is included for fix-issue, before the final RONIN_STATUS marker line', async () => {
    await runAgentTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
    expect(prompt.endsWith(AGENT_NOTES_REMINDER)).toBe(false);
  });

  it('is included for fix-e2e', async () => {
    await runAgentTask({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 });

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

describe('runAgentTask — commit style', () => {
  it('tells every task that opens a PR to follow the repo\'s commit and PR-title convention', async () => {
    for (const task of [
      { type: 'fix-issue' as const, issueNumber: 5, sliceIndex: 0, sliceTitle: 'x' },
      { type: 'implement-slice' as const, issueNumber: 5, sliceIndex: 0, sliceTitle: 'x' },
    ]) {
      runClaudeHeadless.mockClear();
      await runAgentTask(task);
      expect(runClaudeHeadless.mock.calls[0][1]).toContain(COMMIT_STYLE_RULE);
    }
  });
});

describe('sliceTask — revise-spec (#241)', () => {
  const mention = { id: 77, kind: 'review' as const, body: '@ronin-agent sumá al alcance separar los clientes', reactionsEyes: 0, authorLogin: 'persona' };
  const dir = vi.fn(async () => '/tmp/spec-worktree');

  it('runs on the spec branch through its own checkout, with the mention fenced as data', async () => {
    const task = await buildTask({ type: 'revise-spec', issueNumber: 1026, prNumber: 1027, mentions: [mention], dir, outDir: '/tmp/out' });
    expect(task.branch).toBe('ronin/1026/spec');
    expect(task.checkout).toEqual({ kind: 'dir', dir });
    expect(task.prompt).toContain('draft PR #1027');
    expect(task.prompt).toContain('issue #1026');
    expect(task.prompt).toMatch(/Inline comment \(id 77\), untrusted text/);
    expect(task.prompt).toContain('sumá al alcance separar los clientes');
    expect(task.prompt).toContain('docs/superpowers');
  });

  it('asks for a new commit, a reply per mention, and never to mark the PR ready', async () => {
    const { prompt } = await buildTask({ type: 'revise-spec', issueNumber: 1026, prNumber: 1027, mentions: [mention], dir, outDir: '/tmp/out' });
    expect(prompt).toContain('git push origin HEAD:ronin/1026/spec');
    expect(prompt).toContain('Never amend, rebase or force-push');
    expect(prompt).toContain('pulls/1027/comments/<comment id>/replies');
    expect(prompt).toContain('gh pr comment 1027');
    expect(prompt).toContain('Do not mark the PR ready for review');
    expect(prompt).toContain('/tmp/out/mockup.html');
    expect(prompt).toContain(COMMIT_STYLE_RULE);
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });
});
