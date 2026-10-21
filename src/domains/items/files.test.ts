import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPrFiles = vi.fn();
const getDiffThreads = vi.fn();
const getFileAt = vi.fn();
vi.mock('../../platform/github/github.js', () => ({
  getPrFiles: (...args: unknown[]) => getPrFiles(...args),
  getDiffThreads: (...args: unknown[]) => getDiffThreads(...args),
  getFileAt: (...args: unknown[]) => getFileAt(...args),
}));
vi.mock('../../platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const { fileContent, forgetFiles, MAX_CONTENT_BYTES, prFiles, resetFilesCache } = await import('./files.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const FILE = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' };
const THREAD = { id: 'T1', path: 'src/a.ts', subject: 'line', side: 'RIGHT', line: 1, startLine: null, originalLine: 1, isResolved: false, isOutdated: false, url: '', comments: [] };

beforeEach(() => {
  resetFilesCache();
  getPrFiles.mockReset().mockResolvedValue({ headSha: 'h1', baseSha: 'b1', files: [FILE] });
  getDiffThreads.mockReset().mockResolvedValue([THREAD]);
  getFileAt.mockReset().mockResolvedValue('a\nb\n');
});

describe('prFiles', () => {
  it('reads the files and the threads of the PR together', async () => {
    const data = await prFiles(ENTRY, 849);
    expect(getPrFiles).toHaveBeenCalledWith(849);
    expect(getDiffThreads).toHaveBeenCalledWith(849);
    expect(data).toMatchObject({ headSha: 'h1', baseSha: 'b1', files: [FILE], threads: [THREAD] });
  });

  it('serves a fresh read from the cache, and reads again once a run changed it or it was forgotten', async () => {
    const t = Date.now();
    await prFiles(ENTRY, 849, 0, t);
    await prFiles(ENTRY, 849, 0, t + 1000);
    expect(getPrFiles).toHaveBeenCalledTimes(1);
    await prFiles(ENTRY, 849, Date.now() + 60_000, t + 2000);
    expect(getPrFiles).toHaveBeenCalledTimes(2);
    forgetFiles('acme/product');
    await prFiles(ENTRY, 849);
    expect(getPrFiles).toHaveBeenCalledTimes(3);
  });

  it('keeps what it had and says what GitHub answered when a read fails', async () => {
    const t = Date.now();
    await prFiles(ENTRY, 849, 0, t);
    getDiffThreads.mockRejectedValueOnce(new Error('HTTP 502\nmás detalle'));
    // What it had comes back right away, as the read goes on.
    expect(await prFiles(ENTRY, 849, Date.now() + 60_000, t + 1000)).not.toHaveProperty('error');
    await vi.waitFor(() => expect(getDiffThreads).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await prFiles(ENTRY, 849, 0, Date.now())).toMatchObject({ files: [FILE], error: 'HTTP 502' });
  });
});

describe('fileContent', () => {
  it('reads a file at a commit once', async () => {
    expect(await fileContent(ENTRY, 'h1', 'src/a.ts')).toBe('a\nb\n');
    expect(await fileContent(ENTRY, 'h1', 'src/a.ts')).toBe('a\nb\n');
    expect(getFileAt).toHaveBeenCalledTimes(1);
    expect(getFileAt).toHaveBeenCalledWith('h1', 'src/a.ts');
  });

  it('is null for a file too big to show whole', async () => {
    getFileAt.mockResolvedValueOnce('x'.repeat(MAX_CONTENT_BYTES + 1));
    expect(await fileContent(ENTRY, 'h1', 'big.json')).toBeNull();
  });

  it("doesn't keep a failed read", async () => {
    getFileAt.mockRejectedValueOnce(new Error('HTTP 404'));
    await expect(fileContent(ENTRY, 'h1', 'src/a.ts')).rejects.toThrow('HTTP 404');
    expect(await fileContent(ENTRY, 'h1', 'src/a.ts')).toBe('a\nb\n');
  });
});
