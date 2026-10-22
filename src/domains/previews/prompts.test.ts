import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@platform/config/config.js', () => ({
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
    body: '## Cómo se verificó\nTests.\n\n<details><summary>Cómo probar</summary>\n\n**Datos:**\n- un cliente con más de 12 catálogos\n\n**Pasos:**\n1. Como Admin, en /clientes, abrir el cliente: se ven todos\n</details>',
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
    expect(prompt).toContain('<<<PR_START>>>\n# fix: mostrar todos los catálogos\n\n## Cómo se verificó');
    expect(prompt).toContain('<<<REQUEST_START>>>\nque algunos estén vencidos\n<<<REQUEST_END>>>');
    expect(prompt).toContain('git diff abc123..HEAD');
    expect(prompt).toContain('- web:80 → http://127.0.0.1:41234');
    expect(prompt).toContain('docker compose -p p -f f.json exec -T');
    expect(prompt).toContain('Admin: admin@x.com / password');
    expect(prompt).toContain(task.outputPath);
  });

  // #193: what to prepare comes from the PR's «Cómo probar»; the diff only
  // says how to create it, or what's needed when the PR has no such block.
  it('prepares what the PR\'s «Cómo probar» asks for, not what it works out from the diff', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('the "Cómo probar" block of the description');
    expect(prompt).toMatch(/Don't work out on your own what else the change could need/);
    expect(prompt).toMatch(/Only when the description has no such block, work it out from the diff/);
  });

  // A PR behind a flag whose steps start with it off: the preview turns it
  // on anyway, and says how to turn it off.
  it('leaves the change\'s feature flags on for the seeded logins', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toMatch(/behind a feature flag .* leave it ON for the tenant and users the seeded logins use, even when the steps start with it off/);
    expect(prompt).toMatch(/how to turn it off/);
    // The agent can't change the app's environment: it says so instead.
    expect(prompt).toMatch(/only lives in the environment .* don't touch it, and say in "noPreparado"/);
  });

  it('forbids touching code, the stack or GitHub', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toMatch(/never edit, commit or push code/i);
    expect(prompt).toMatch(/do not stop, restart or rebuild the app/i);
    expect(prompt).toMatch(/never write to github/i);
  });

  it('on an update, gives only the new commits and what was already there', async () => {
    await runAgentTask({ ...task, diff: { mergeBase: 'old123', stat: ' 1 file changed' }, previous: { preparado: ['Cliente demo con 30 catálogos'], noPreparado: [] } });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('git diff old123..HEAD');
    expect(prompt).toContain('<<<PREVIOUS_START>>>\nPreparado:\n- Cliente demo con 30 catálogos\nNo preparado:\n- (nada)');
    expect(prompt).toMatch(/never delete or redo what the earlier run left/);
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
    body: '## Cómo se verificó\nTests.\n\n<details><summary>Cómo probar</summary>\n\n**Datos:**\n- un cliente con más de 12 catálogos\n\n**Pasos:**\n1. Como Admin, en /clientes, abrir el cliente: se ven todos\n</details>',
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
    expect(prompt).toMatch(/behind a feature flag or another switch the catalog doesn't show on is never enough/);
    expect(prompt).toContain('every precondition in the "Cómo probar" block of the description');
    expect(prompt).toContain(`JSON object to ${task.outputPath}`);
  });
});

describe('runAgentTask — preview-data-delta', () => {
  it('asks for a yes/no on the new commits, with what the data already covers', async () => {
    await runAgentTask(previewTask({
      type: 'preview-data-delta',
      prNumber: 818,
      checkoutDir: '/tmp/worktrees/preview-pr-818',
      title: 'fix: mostrar todos los catálogos',
      body: '## Cómo se verificó\nTests.\n\n<details><summary>Cómo probar</summary>\n\n**Datos:**\n- un cliente con más de 12 catálogos\n\n**Pasos:**\n1. Como Admin, en /clientes, abrir el cliente: se ven todos\n</details>',
      diff: { from: 'old123', stat: ' 1 file changed' },
      previous: { preparado: ['Cliente demo con 30 catálogos'], noPreparado: ['un cliente sin email'] },
    }));

    expect(runClaudeHeadless.mock.calls[0][0]).toBe('/tmp/worktrees/preview-pr-818');
    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('git diff old123..HEAD');
    expect(prompt).toContain('- un cliente sin email');
    expect(prompt).toContain('{"completar": true | false');
    expect(prompt).toMatch(/"Cómo probar" block, it is what has to be tried now/);
    expect(prompt).not.toContain('REQUEST_START');
  });
});
