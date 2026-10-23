import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_NOTES_REMINDER, COMMIT_STYLE_RULE, PR_BODY_RULE, PR_BODY_SECTIONS } from '@platform/agents/prompts.js';

vi.mock('@platform/config/config.js', () => ({
  config: {
    worktreeBaseRef: 'origin/main',
    externalReviewWorkerModel: 'sonnet',
    githubLogin: 'ronin-agent',
    specDir: 'docs/ronin',
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

describe('sliceTask — implementing with the skill (#257)', () => {
  it("builds slice 0 on the active repo's own worktreeBaseRef, and opens its PR there", async () => {
    activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees', worktreeBaseRef: 'origin/odoo-main' });
    const task = await buildTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

    expect(task.checkout).toEqual({ kind: 'branch', baseBranch: 'origin/odoo-main' });
    expect(task.actions).toMatchObject({
      headRef: 'ronin/228/slice-1',
      push: { mode: 'branch', baseRef: 'origin/odoo-main' },
      pr: { base: 'odoo-main', draft: false },
      allowed: ['git.push', 'pr.create', 'services.up', 'services.run', 'result.report'],
    });
    expect(task.actions).not.toHaveProperty('issue');
    expect(task.prompt).toContain('ronin:implement');
    expect(task.prompt).toContain('<<<SLICE_START>>>Add foo<<<SLICE_END>>>');
    // Its PR never closes the issue: ronin does, after the last slice.
    expect(task.actions?.pr).not.toHaveProperty('closes');
    expect(task.prompt).toContain('"Parte de #228", nunca "Closes"');
  });

  it('stacks a later slice on the previous one, while that branch is on origin', async () => {
    remoteBranchExists.mockResolvedValue(true);
    const task = await buildTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 1, sliceTitle: 'Add bar' });
    expect(task.actions).toMatchObject({ push: { baseRef: 'ronin/228/slice-1' }, pr: { base: 'ronin/228/slice-1' } });
  });

  it('lets fix-issue ask on its issue, closes it from the PR and asks for a status', async () => {
    activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees', worktreeBaseRef: 'origin/odoo-main' });
    const task = await buildTask({ type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    expect(task.actions).toMatchObject({
      issue: { number: 228 },
      pr: { base: 'odoo-main', draft: false, closes: 228 },
      allowed: ['issue.comment', 'git.push', 'pr.create', 'services.up', 'services.run', 'result.report'],
    });
    expect(task.prompt).toContain('gh issue view 228 --comments');
    expect(task.prompt).toContain('"Closes #228"');
    expect(task.prompt).toContain('status "done"');
    expect(task.prompt).toContain('"ronin-ficha:"');
    expect(task.prompt).toContain('/antes-<n>.<ext>');
  });

  it.each([
    ['implement-slice', 'Add foo'],
    ['fix-issue', 'Fix foo'],
  ] as const)('gives %s the PR body and commit rules', async (type, sliceTitle) => {
    const { prompt } = await buildTask({ type, issueNumber: 228, sliceIndex: 0, sliceTitle });
    expect(prompt).toContain(PR_BODY_RULE);
    for (const heading of PR_BODY_SECTIONS) expect(prompt).toContain(`"## ${heading}"`);
    expect(prompt).toContain(COMMIT_STYLE_RULE);
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).not.toContain('RONIN_STATUS');
  });
});

describe('runAgentTask — agent-notes reminder', () => {
  it('is NOT included for plan', async () => {
    const { prompt } = await buildTask({ type: 'plan', issueNumber: 228, specPaths: ['docs/ronin/specs/foo.md'] });
    expect(prompt).not.toContain(AGENT_NOTES_REMINDER);
  });
});

describe('sliceTask — fix-e2e (#257)', () => {
  it("amends its own PR's commit on the PR branch, with the fix-ci skill", async () => {
    const { checkout, actions, prompt } = await buildTask({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 });

    expect(checkout).toEqual({ kind: 'pr-branch' });
    expect(actions).toMatchObject({ prNumber: 229, headRef: 'ronin/228/slice-1', push: { mode: 'amend' }, allowed: ['git.push', 'services.up', 'services.run', 'result.report'] });
    expect(prompt).toContain('ronin:fix-ci');
    expect(prompt).not.toContain('git push');
  });
});

describe('sliceTask — plan (#257)', () => {
  it('reads the spec and may only replace the issue body', async () => {
    const { prompt, actions } = await buildTask({ type: 'plan', issueNumber: 228, specPaths: ['docs/ronin/specs/a.md', 'docs/ronin/specs/b.md'] });

    expect(actions).toMatchObject({ issue: { number: 228, body: 'replace' }, allowed: ['issue.update-body', 'result.report'] });
    expect(prompt).toContain('ronin:plan-slices');
    expect(prompt).toContain('- docs/ronin/specs/a.md\n- docs/ronin/specs/b.md');
    expect(prompt).not.toContain('## Slices');
  });

  it("only adds the slices at the end of the issue a /spec came from: its description is the person's", async () => {
    const { prompt, actions } = await buildTask({ type: 'plan', issueNumber: 300, specPaths: ['docs/ronin/specs/a.md'], keepBody: true });
    expect(actions).toMatchObject({ issue: { number: 300, body: 'append' } });
    expect(prompt).toContain('no la reemplaces');
    expect(prompt).toContain('"## Slices"');
  });
});

describe('sliceTask — revise-spec (#241, #257)', () => {
  const mention = { id: 77, kind: 'review' as const, body: '@ronin-agent sumá al alcance separar los clientes', reactionsEyes: 0, authorLogin: 'persona' };

  it("works on the spec branch as origin has it, with the mention fenced as data", async () => {
    const task = await buildTask({ type: 'revise-spec', issueNumber: 1026, prNumber: 1027, mentions: [mention], outDir: '/tmp/out' });
    expect(task.branch).toBe('ronin/1026/spec');
    expect(task.checkout).toEqual({ kind: 'pr-branch' });
    expect(task.prompt).toContain('ronin:revise-spec');
    expect(task.prompt).toContain('spec del PR #1027');
    expect(task.prompt).toContain('(id 77, kind "review")');
    expect(task.prompt).toContain('sumá al alcance separar los clientes');
    expect(task.prompt).toContain('/tmp/out/mockup.html');
    expect(task.prompt).toContain(COMMIT_STYLE_RULE);
  });

  it('only adds commits on top, answers each mention, and leaves the mockup in its output directory', async () => {
    const task = await buildTask({ type: 'revise-spec', issueNumber: 1026, prNumber: 1027, mentions: [mention], outDir: '/tmp/out' });
    expect(task.actions).toMatchObject({
      prNumber: 1027,
      headRef: 'ronin/1026/spec',
      push: { mode: 'fast-forward' },
      triggers: [{ id: 77, kind: 'review' }],
      allowed: ['pr.reply', 'pr.comment', 'pr.update-body', 'git.push', 'result.report'],
    });
    expect(task.sealed).toEqual({ outputDir: '/tmp/out' });
  });
});

describe('sliceTask — write-spec (#257)', () => {
  it('opens a PR assigned to ronin from its own branch, not a draft (approving it is the go), or asks on the issue', async () => {
    const task = await buildTask({ type: 'write-spec', issueNumber: 900, appName: 'backoffice', trigger: [{ id: 5, kind: 'issue', body: '/spec backoffice', reactionsEyes: 0, authorLogin: 'persona' }], outDir: '/tmp/spec-out' });
    expect(task.checkout).toEqual({ kind: 'branch', baseBranch: 'origin/main' });
    expect(task.actions).toMatchObject({
      headRef: 'ronin/900/spec',
      push: { mode: 'branch', baseRef: 'origin/main' },
      pr: { base: 'main', draft: false, assignee: 'ronin-agent' },
      issue: { number: 900 },
      allowed: ['issue.comment', 'git.push', 'pr.create', 'services.up', 'services.run', 'result.report'],
    });
    expect(task.sealed).toEqual({ outputDir: '/tmp/spec-out' });
    expect(task.prompt).toContain('ronin:write-spec');
    expect(task.prompt).toContain('/tmp/spec-out/mockup.html');
    expect(task.prompt).toContain('aprobalo: esa es la señal');
    expect(task.prompt).toContain('status "done"');
  });
});
