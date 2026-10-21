import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = { productRepo: 'acme/product', productRepoPath: '', worktreeBasePath: '' };
vi.mock('../../core/repo-context.js', () => ({ activeRepo: () => repo }));
vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../core/config.js', () => ({ config: { githubLogin: 'ronin' } }));
const runAgentTask = vi.fn();
vi.mock('../../core/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));

const { resolveConflicts, parseAgentResolution, renderConflictsOutcome } = await import('./conflicts.js');

let root: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

// origin with "main" and "feature" branched from it; `onMain` and
// `onFeature` are what each side then writes to app.txt.
function setup(onMain: string | null, onFeature: string): void {
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  for (const dir of [seed]) {
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
  }
  commit(seed, 'app.txt', 'uno\ndos\ntres\n', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-q', '-b', 'feature');
  commit(seed, 'app.txt', onFeature, 'feature');
  git(seed, 'push', '-q', 'origin', 'feature');
  if (onMain !== null) {
    git(seed, 'checkout', '-q', 'main');
    commit(seed, 'app.txt', onMain, 'main');
    git(seed, 'push', '-q', 'origin', 'main');
  }
  repo.productRepoPath = join(root, 'product');
  git(root, 'clone', '-q', origin, repo.productRepoPath);
  git(repo.productRepoPath, 'config', 'user.name', 'Ronin');
  git(repo.productRepoPath, 'config', 'user.email', 'ronin@example.com');
}

const pr = { state: 'OPEN' as const, headRefOid: '', headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, title: 'Feature', body: '' };

function originFile(branch: string): string {
  return git(origin, 'show', `${branch}:app.txt`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ronin-conflicts-'));
  origin = join(root, 'origin.git');
  repo.worktreeBasePath = join(root, 'worktrees');
  runAgentTask.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveConflicts', () => {
  it('says so and pushes nothing when the PR already has the base', async () => {
    setup(null, 'uno\nDOS\ntres\n');
    const before = git(origin, 'rev-parse', 'feature');

    expect(await resolveConflicts(1, pr)).toEqual({ kind: 'up-to-date', base: 'main' });
    expect(git(origin, 'rev-parse', 'feature')).toBe(before);
  });

  it('merges and pushes without the agent when git resolves it alone', async () => {
    setup('UNO\ndos\ntres\n', 'uno\ndos\nTRES\n');

    const outcome = await resolveConflicts(1, pr);
    expect(outcome.kind).toBe('merged-clean');
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(originFile('feature')).toBe('UNO\ndos\nTRES');
    expect(git(origin, 'rev-parse', 'feature^2')).toBe(git(origin, 'rev-parse', 'main'));
  });

  it('has the agent resolve the conflicted files, then commits the merge and pushes it', async () => {
    setup('uno\ndos (main)\ntres\n', 'uno\ndos (feature)\ntres\n');
    runAgentTask.mockImplementation(async (task: { checkoutDir: string; outputPath: string; conflictedFiles: string[] }) => {
      expect(task.conflictedFiles).toEqual(['app.txt']);
      writeFileSync(join(task.checkoutDir, 'app.txt'), 'uno\ndos (main + feature)\ntres\n');
      git(task.checkoutDir, 'add', 'app.txt');
      writeFileSync(task.outputPath, JSON.stringify({ resuelto: true, archivos: ['`app.txt`: junté los dos cambios'], revisar: [], verificacion: 'tests en verde' }));
    });

    const outcome = await resolveConflicts(1, pr);
    expect(outcome).toMatchObject({ kind: 'resolved', files: ['app.txt'], resolution: { archivos: ['`app.txt`: junté los dos cambios'] } });
    expect(originFile('feature')).toBe('uno\ndos (main + feature)\ntres');
    expect(git(origin, 'rev-parse', 'feature^2')).toBe(git(origin, 'rev-parse', 'main'));
  });

  it("commits the merge even when the product repo's commit hooks would fail", async () => {
    setup('uno\ndos (main)\ntres\n', 'uno\ndos (feature)\ntres\n');
    const hooks = join(root, 'hooks');
    mkdirSync(hooks);
    for (const hook of ['pre-commit', 'pre-merge-commit', 'commit-msg']) {
      writeFileSync(join(hooks, hook), '#!/bin/sh\necho "dotnet: not found" >&2\nexit 1\n');
      chmodSync(join(hooks, hook), 0o755);
    }
    git(repo.productRepoPath, 'config', 'core.hooksPath', hooks);
    runAgentTask.mockImplementation(async (task: { checkoutDir: string; outputPath: string }) => {
      writeFileSync(join(task.checkoutDir, 'app.txt'), 'uno\ndos (main + feature)\ntres\n');
      git(task.checkoutDir, 'add', 'app.txt');
      writeFileSync(task.outputPath, JSON.stringify({ resuelto: true, archivos: [], revisar: [], verificacion: '' }));
    });

    expect(await resolveConflicts(1, pr)).toMatchObject({ kind: 'resolved' });
    expect(originFile('feature')).toBe('uno\ndos (main + feature)\ntres');
  });

  it('pushes nothing when the agent says it resolved them but left conflict markers', async () => {
    setup('uno\ndos (main)\ntres\n', 'uno\ndos (feature)\ntres\n');
    const before = git(origin, 'rev-parse', 'feature');
    runAgentTask.mockImplementation(async (task: { checkoutDir: string; outputPath: string }) => {
      git(task.checkoutDir, 'add', 'app.txt');
      writeFileSync(task.outputPath, JSON.stringify({ resuelto: true, archivos: [], revisar: [], verificacion: '' }));
    });

    const outcome = await resolveConflicts(1, pr);
    expect(outcome).toMatchObject({ kind: 'unresolved', reason: 'quedaron marcas de conflicto en app.txt' });
    expect(git(origin, 'rev-parse', 'feature')).toBe(before);
  });

  it('pushes nothing when the agent leaves a decision to the team', async () => {
    setup('uno\ndos (main)\ntres\n', 'uno\ndos (feature)\ntres\n');
    const before = git(origin, 'rev-parse', 'feature');
    runAgentTask.mockImplementation(async (task: { outputPath: string }) => {
      writeFileSync(task.outputPath, JSON.stringify({ resuelto: false, archivos: [], revisar: ['los dos lados cambian el mismo cálculo'], verificacion: '', error: 'necesita una decisión del equipo' }));
    });

    const outcome = await resolveConflicts(1, pr);
    expect(outcome).toMatchObject({ kind: 'unresolved', reason: 'necesita una decisión del equipo' });
    expect(git(origin, 'rev-parse', 'feature')).toBe(before);
  });

  it('never overwrites commits pushed to the branch while it was resolving', async () => {
    setup('uno\ndos (main)\ntres\n', 'uno\ndos (feature)\ntres\n');
    runAgentTask.mockImplementation(async (task: { checkoutDir: string; outputPath: string }) => {
      const other = join(root, 'other');
      git(root, 'clone', '-q', '-b', 'feature', origin, other);
      git(other, 'config', 'user.name', 'Ana');
      git(other, 'config', 'user.email', 'ana@example.com');
      commit(other, 'otro.txt', 'nuevo\n', 'otro cambio');
      git(other, 'push', '-q', 'origin', 'feature');
      writeFileSync(join(task.checkoutDir, 'app.txt'), 'uno\ndos\ntres\n');
      git(task.checkoutDir, 'add', 'app.txt');
      writeFileSync(task.outputPath, JSON.stringify({ resuelto: true, archivos: [], revisar: [], verificacion: '' }));
    });
    const outcome = await resolveConflicts(1, pr);
    expect(outcome).toEqual({ kind: 'branch-moved', base: 'main' });
    expect(git(origin, 'log', '-1', '--format=%s', 'feature')).toBe('otro cambio');
  });

  it('leaves no checkout behind', async () => {
    setup('UNO\ndos\ntres\n', 'uno\ndos\nTRES\n');
    await resolveConflicts(1, pr);
    expect(git(repo.productRepoPath, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(() => readFileSync(join(repo.worktreeBasePath, 'conflicts-pr-1', 'app.txt'))).toThrow();
  });
});

describe('parseAgentResolution', () => {
  it('is only resolved when the agent says so and gives no error', () => {
    expect(parseAgentResolution('{"resuelto": true, "archivos": ["a"], "revisar": [" b ", ""], "verificacion": " ok "}'))
      .toEqual({ resuelto: true, archivos: ['a'], revisar: ['b'], verificacion: 'ok' });
    expect(parseAgentResolution('{"resuelto": true, "error": "no pude"}')).toMatchObject({ resuelto: false, error: 'no pude' });
    expect(parseAgentResolution('{"resuelto": "sí"}').resuelto).toBe(false);
  });
});

describe('renderConflictsOutcome', () => {
  it('tells how each file was resolved and what to review', () => {
    const text = renderConflictsOutcome({
      kind: 'resolved', base: 'main', sha: 'abcdef1234', files: ['a.ts'],
      resolution: { resuelto: true, archivos: ['`a.ts`: junté los dos'], revisar: ['mirá el redondeo'], verificacion: 'typecheck y tests en verde' },
    }, 'ronin');
    expect(text).toContain('abcdef1');
    expect(text).toContain('- `a.ts`: junté los dos');
    expect(text).toContain('**Para revisar antes de mergear**\n- mirá el redondeo');
    expect(text).toContain('typecheck y tests en verde');
  });

  it('asks to run it again when the branch moved', () => {
    expect(renderConflictsOutcome({ kind: 'branch-moved', base: 'main' }, 'ronin')).toContain('`@ronin /resolve-conflicts`');
  });
});
