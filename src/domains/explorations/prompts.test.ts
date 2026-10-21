import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REALISTIC_DATA_RULE } from '../../platform/agents/prompts.js';

vi.mock('../../platform/config/config.js', () => ({
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
vi.mock('../../platform/agents/repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const ensureWorktree = vi.fn();
const remoteBranchExists = vi.fn();
const ensureExternalReviewWorktree = vi.fn();
const removeExternalReviewWorktree = vi.fn();
const ensureTrustedFixWorktree = vi.fn();
const removeTrustedFixWorktree = vi.fn();
vi.mock('../../platform/git/worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  remoteBranchExists: (...args: unknown[]) => remoteBranchExists(...args),
  ensureExternalReviewWorktree: (...args: unknown[]) => ensureExternalReviewWorktree(...args),
  removeExternalReviewWorktree: (...args: unknown[]) => removeExternalReviewWorktree(...args),
  ensureTrustedFixWorktree: (...args: unknown[]) => ensureTrustedFixWorktree(...args),
  removeTrustedFixWorktree: (...args: unknown[]) => removeTrustedFixWorktree(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('../../platform/claude/claude-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/claude/claude-runner.js')>()),
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const getPullRequestStatus = vi.fn();
vi.mock('../../platform/github/github.js', () => ({
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

const { explorationTask, CHARTER_MISSIONS } = await import('./prompts.js');
const buildTask = (task: Parameters<typeof explorationTask>[0]) => explorationTask(task).prepare();

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

describe('explorationTask — data the team sees in screenshots', () => {
  const app = { appName: 'backoffice', appPath: 'apps/backoffice', checkoutDir: '/tmp/w', outDir: '/tmp/out', outputPath: '/tmp/out/r.json', mcpConfigPath: '/tmp/mcp.json', baseUrl: 'http://127.0.0.1:1', homePath: '/' };

  it('asks every agent that creates data in the app for realistic data', async () => {
    const prompts = await Promise.all([
      buildTask({ type: 'explore-function', ...app, fn: { id: 'pedidos.surtir', nombre: 'Surtir', rutas: ['/pedidos'] }, charter: 'datos-hostiles', role: 'Admin', seed: 1, knowledge: '', existing: [], maxIdeas: 1 }),
      buildTask({ type: 'explore-redo-after', ...app, role: 'Admin', viewport: 'desktop', findingId: 'F-0001', findingFile: 'f.md', instruction: 'x' }),
    ]);
    for (const { prompt } of prompts) expect(prompt).toContain(REALISTIC_DATA_RULE);
  });

  it('keeps the hostile-data charter to characters the app\'s users could type', () => {
    expect(CHARTER_MISSIONS['datos-hostiles']).toContain("unusual characters this app's users could really type");
  });
});
