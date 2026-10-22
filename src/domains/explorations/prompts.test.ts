import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

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

const { explorationTask } = await import('./prompts.js');
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

// What each exploration task does is in its skill (#257); the prompt
// carries the run.
const skill = readFileSync('plugin/skills/explore/SKILL.md', 'utf8');

describe('explorationTask', () => {
  const app = { appName: 'backoffice', appPath: 'apps/backoffice', checkoutDir: '/tmp/w', outDir: '/tmp/out', outputPath: '/tmp/out/r.json', mcpConfigPath: '/tmp/mcp.json', baseUrl: 'http://127.0.0.1:1', homePath: '/' };

  it('names the skill and the job in every task', async () => {
    const prompts = await Promise.all([
      buildTask({ type: 'explore-inventory', appName: 'backoffice', appPath: 'apps/backoffice', checkoutDir: '/tmp/w', outputPath: '/tmp/out/i.json', roles: ['Admin'], known: [] }),
      buildTask({ type: 'explore-function', ...app, fn: { id: 'pedidos.surtir', nombre: 'Surtir', rutas: ['/pedidos'] }, charter: 'datos-hostiles', role: 'Admin', seed: 1, knowledge: '', existing: [], maxIdeas: 1 }),
      buildTask({ type: 'explore-evaluate', appName: 'backoffice', checkoutDir: '/tmp/w', candidatesPath: '/tmp/c.json', outputPath: '/tmp/v.json', knowledge: '', existing: [] }),
      buildTask({ type: 'explore-feedback', prNumber: 9, checkoutDir: '/tmp/w', comments: [], outputPath: '/tmp/f.json' }),
      buildTask({ type: 'explore-redo-after', ...app, role: 'Admin', viewport: 'desktop', findingId: 'F-0001', findingFile: 'f.md', instruction: 'x' }),
    ]);
    const jobs = ['el inventario', 'explorar una función', 'evaluar los candidatos', 'los comentarios del PR', 'rehacer el después de un hallazgo'];
    prompts.forEach(({ prompt, sealed }, i) => {
      expect(prompt.startsWith(`Usa la skill ronin:explore, para ${jobs[i]}.`)).toBe(true);
      expect(sealed).toBeDefined();
    });
  });

  it('gives the function run its charter, seed and limits, and what already exists', async () => {
    const { prompt } = await buildTask({ type: 'explore-function', ...app, fn: { id: 'pedidos.surtir', nombre: 'Surtir', rutas: ['/pedidos'] }, charter: 'datos-hostiles', role: 'Admin', seed: 7, knowledge: 'No proponer mobile', existing: [{ id: 'F-0002', funcion: 'pedidos.surtir', titulo: 't', estado: 'rechazado', huella: 'h', motivo: 'ya está' }], maxIdeas: 2 });
    expect(prompt).toContain('El charter de esta corrida: "datos-hostiles". La semilla: 7. Ideas: como mucho 2.');
    expect(prompt).toContain('<<<KNOWLEDGE_START>>>\nNo proponer mobile\n<<<KNOWLEDGE_END>>>');
    expect(prompt).toContain('- F-0002 [rechazado] pedidos.surtir: t — huella "h" — rechazado porque: ya está');
    expect(prompt).toContain('"candidatos"');
  });

  it('asks every agent that creates data in the app for realistic data', () => {
    expect(skill).toMatch(/\*\*Datos realistas,\*\* cuando creas datos en la app/);
  });

  it('keeps the hostile-data charter to characters the app\'s users could type', () => {
    expect(skill).toContain('caracteres raros que los usuarios de esta app podrían escribir de verdad');
  });

  it('only takes findings observed while using the app', () => {
    expect(skill).toContain('un candidato que sale solo de leer código —algo que no observaste en el navegador— no es un hallazgo');
  });
});
