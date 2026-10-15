import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/config.js', () => ({
  config: { worktreeBaseRef: 'origin/main' },
}));

const execFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFile(...args),
}));

const activeRepo = vi.fn();
vi.mock('../core/repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const { fetchOriginMain, readSpecFile } = await import('./spec-content.js');

beforeEach(() => {
  vi.clearAllMocks();
  activeRepo.mockReturnValue({ productRepoPath: '/tmp/repo' });
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: '', stderr: '' }),
  );
});

describe('fetchOriginMain', () => {
  it('fetches the global default branch (origin/main) when the active repo has no override', async () => {
    await fetchOriginMain();

    expect(execFile).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], { cwd: '/tmp/repo' }, expect.any(Function));
  });

  it("fetches the active repo's own worktreeBaseRef override instead of the global default", async () => {
    activeRepo.mockReturnValue({ productRepoPath: '/tmp/repo', worktreeBaseRef: 'origin/odoo-main' });

    await fetchOriginMain();

    expect(execFile).toHaveBeenCalledWith('git', ['fetch', 'origin', 'odoo-main'], { cwd: '/tmp/repo' }, expect.any(Function));
  });
});

describe('readSpecFile', () => {
  it('reads the file as of the global default branch (origin/main) when the active repo has no override', async () => {
    await readSpecFile('docs/superpowers/specs/foo.md');

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['show', 'origin/main:docs/superpowers/specs/foo.md'],
      { cwd: '/tmp/repo' },
      expect.any(Function),
    );
  });

  it("reads the file as of the active repo's own worktreeBaseRef override", async () => {
    activeRepo.mockReturnValue({ productRepoPath: '/tmp/repo', worktreeBaseRef: 'origin/odoo-main' });

    await readSpecFile('docs/superpowers/specs/foo.md');

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['show', 'origin/odoo-main:docs/superpowers/specs/foo.md'],
      { cwd: '/tmp/repo' },
      expect.any(Function),
    );
  });
});
