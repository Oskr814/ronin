import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: {
    valeriaRepo: 'Bmedical/ValerIA',
    githubAppSlug: 'valeria',
    githubAppId: '12345',
    playwrightTestResultsDir: 'apps/webapp/test-results',
  },
}));

const existsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
}));

const mkdir = vi.fn();
const readdir = vi.fn();
const copyFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mkdir(...args),
  readdir: (...args: unknown[]) => readdir(...args),
  copyFile: (...args: unknown[]) => copyFile(...args),
}));

const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(null));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFile as any)(...args),
}));

const { publishEvidence } = await import('./evidence.js');

beforeEach(() => {
  vi.clearAllMocks();
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(null));
  existsSync.mockReturnValue(true); // evidence checkout already cloned
  mkdir.mockResolvedValue(undefined);
  copyFile.mockResolvedValue(undefined);
  readdir.mockImplementation(async (dir: string) => {
    if (dir === '/tmp/worktree/apps/webapp/test-results') {
      return [{ name: 'login-smoke-chromium', isDirectory: () => true, isFile: () => false }];
    }
    if (dir === '/tmp/worktree/apps/webapp/test-results/login-smoke-chromium') {
      return [{ name: 'test-finished-1.png', isDirectory: () => false, isFile: () => true }];
    }
    return [];
  });
  vi.spyOn(Date, 'now').mockReturnValue(1234567890);
});

describe('publishEvidence', () => {
  it('writes each publish under a timestamped subfolder, never a flat per-PR path', async () => {
    const committed = await publishEvidence(228, 229, '/tmp/worktree');

    expect(committed).toEqual(['evidence/228/229/1234567890/login-smoke-chromium-test-finished-1.png']);
  });

  it('returns [] without touching the evidence checkout when there are no screenshots', async () => {
    readdir.mockResolvedValue([]);

    const committed = await publishEvidence(228, 229, '/tmp/worktree');

    expect(committed).toEqual([]);
    expect(mkdir).not.toHaveBeenCalled();
  });
});
