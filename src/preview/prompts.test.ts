import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/config.js', () => ({
  config: {
    worktreeBaseRef: 'origin/main',
    externalReviewWorkerModel: 'sonnet',
    githubLogin: 'ronin-agent',
  },
  agentModelFor: (taskType: string) => `model-for-${taskType}`,
  agentEffortFor: (taskType: string) => `effort-for-${taskType}`,
  reviewWorkerModel: () => 'sonnet',
}));

const activeRepo = vi.fn();
vi.mock('../core/repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const ensureWorktree = vi.fn();
const remoteBranchExists = vi.fn();
const ensureExternalReviewWorktree = vi.fn();
const removeExternalReviewWorktree = vi.fn();
const ensureTrustedFixWorktree = vi.fn();
const removeTrustedFixWorktree = vi.fn();
vi.mock('../core/worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  remoteBranchExists: (...args: unknown[]) => remoteBranchExists(...args),
  ensureExternalReviewWorktree: (...args: unknown[]) => ensureExternalReviewWorktree(...args),
  removeExternalReviewWorktree: (...args: unknown[]) => removeExternalReviewWorktree(...args),
  ensureTrustedFixWorktree: (...args: unknown[]) => ensureTrustedFixWorktree(...args),
  removeTrustedFixWorktree: (...args: unknown[]) => removeTrustedFixWorktree(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('../core/claude-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/claude-runner.js')>()),
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const getPullRequestStatus = vi.fn();
vi.mock('../core/github.js', () => ({
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

const { runAgentTask: run } = await import('../core/agent-task.js');
const { previewTask } = await import('./prompts.js');
// Each task runs through the real runAgentTask, with its checkout and
// `claude -p` mocked: what a test reads is the prompt it was handed.
const runAgentTask = (task: Parameters<typeof previewTask>[0]) => run(previewTask(task));
const buildTask = (task: Parameters<typeof previewTask>[0]) => previewTask(task).prepare();

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

describe('runAgentTask — prepare-preview-data', () => {
  const task = {
    type: 'prepare-preview-data' as const,
    prNumber: 818,
    appName: 'backoffice',
    appPath: 'apps/backoffice',
    checkoutDir: '/tmp/worktrees/preview-pr-818',
    outputPath: '/tmp/worktrees/preview-pr-818/.ronin-app/preview-data.json',
    title: 'fix: mostrar todos los catálogos',
    body: '## ¿Cómo probar?\n1. Asignar más de 12 catálogos a un cliente',
    instruction: 'que algunos estén vencidos',
    diff: { mergeBase: 'abc123', stat: ' 4 files changed' },
    baseUrl: 'http://127.0.0.1:5173',
    services: '- web:80 → http://127.0.0.1:41234',
    compose: 'docker compose -p p -f f.json',
    users: [{ role: 'Admin', username: 'admin@x.com', password: 'password' }],
  };

  it('runs in the preview checkout, never a worktree of its own', async () => {
    await runAgentTask(task);

    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(runClaudeHeadless.mock.calls[0][0]).toBe('/tmp/worktrees/preview-pr-818');
  });

  it('gives the PR, the request and the running stack, fencing what people wrote', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('<<<PR_START>>>\n# fix: mostrar todos los catálogos\n\n## ¿Cómo probar?');
    expect(prompt).toContain('<<<REQUEST_START>>>\nque algunos estén vencidos\n<<<REQUEST_END>>>');
    expect(prompt).toContain('git diff abc123..HEAD');
    expect(prompt).toContain('- web:80 → http://127.0.0.1:41234');
    expect(prompt).toContain('docker compose -p p -f f.json exec -T');
    expect(prompt).toContain('Admin: admin@x.com / password');
    expect(prompt).toContain(task.outputPath);
  });

  it('forbids touching code, the stack or GitHub', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toMatch(/never edit, commit or push code/i);
    expect(prompt).toMatch(/do not stop, restart or rebuild the app/i);
    expect(prompt).toMatch(/never write to github/i);
  });

  it('leaves out the request block when nothing was asked', async () => {
    const { instruction: _, ...withoutRequest } = task;
    await runAgentTask(withoutRequest);

    expect(runClaudeHeadless.mock.calls[0][1]).not.toContain('REQUEST_START');
  });
});

describe('runAgentTask — prepare-preview-data with a catalog', () => {
  const task = {
    type: 'prepare-preview-data' as const,
    prNumber: 818,
    appName: 'backoffice',
    appPath: 'apps/backoffice',
    checkoutDir: '/tmp/worktrees/preview-pr-818',
    outputPath: '/tmp/out.json',
    title: 't',
    body: 'b',
    diff: { mergeBase: 'abc123', stat: '' },
    baseUrl: 'http://127.0.0.1:5173',
    services: '',
    compose: 'docker compose',
    users: [],
  };

  it('hands it fenced, and says not to explore the schema again', async () => {
    const { prompt } = await buildTask({ ...task, catalog: 'clientes:\n  total: 8' });

    expect(prompt).toContain('<<<CATALOG_START>>>\nclientes:\n  total: 8\n<<<CATALOG_END>>>');
    expect(prompt).toMatch(/trust it: don't explore the schema/);
  });

  it('says nothing about a catalog without one', async () => {
    const { prompt } = await buildTask(task);

    expect(prompt).not.toContain('CATALOG_START');
  });
});

describe('runAgentTask — preview-seed-catalog', () => {
  const task = {
    type: 'preview-seed-catalog' as const,
    prNumber: 818,
    appName: 'backoffice',
    appPath: 'apps/backoffice',
    checkoutDir: '/tmp/worktrees/preview-pr-818',
    outputPath: '/tmp/worktrees/preview-pr-818/.ronin-app/seed-catalog.yaml',
    baseUrl: 'http://127.0.0.1:5173',
    services: '- web:80 → http://127.0.0.1:41234',
    compose: 'docker compose -p p -f f.json',
    users: [{ role: 'Admin', username: 'admin@x.com', password: 'password' }],
  };

  it('runs in the preview checkout, read only, and writes YAML to its output', async () => {
    await runAgentTask(task);

    expect(runClaudeHeadless.mock.calls[0][0]).toBe('/tmp/worktrees/preview-pr-818');
    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toMatch(/don't create, change or delete any data/);
    expect(prompt).toMatch(/never write to github/i);
    expect(prompt).toContain('docker compose -p p -f f.json exec -T');
    expect(prompt).toContain('Admin: admin@x.com / password');
    expect(prompt).toContain(`YAML to ${task.outputPath}`);
  });
});

describe('runAgentTask — preview-data-triage', () => {
  const task = {
    type: 'preview-data-triage' as const,
    prNumber: 818,
    checkoutDir: '/tmp/worktrees/preview-pr-818',
    outputPath: '/tmp/triage.json',
    title: 'fix: mostrar todos los catálogos',
    body: '## ¿Cómo probar?\n1. Asignar más de 12 catálogos a un cliente',
    instruction: 'que algunos estén vencidos',
    diff: { mergeBase: 'abc123', stat: ' 4 files changed' },
    catalog: 'clientes:\n  total: 8',
  };

  it('gives the PR, the request and the catalog, fenced, and asks for yes or no', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('<<<PR_START>>>\n# fix: mostrar todos los catálogos');
    expect(prompt).toContain('<<<REQUEST_START>>>\nque algunos estén vencidos\n<<<REQUEST_END>>>');
    expect(prompt).toContain('<<<CATALOG_START>>>\nclientes:\n  total: 8\n<<<CATALOG_END>>>');
    expect(prompt).toContain('git diff abc123..HEAD');
    expect(prompt).toMatch(/unsure, it is not enough/);
    expect(prompt).toContain(`JSON object to ${task.outputPath}`);
  });
});
