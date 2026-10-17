import { describe, it, expect, vi, beforeEach } from 'vitest';

const commentOnDiff = vi.fn();
const replyToReviewComment = vi.fn();
const setThreadResolved = vi.fn();
const setFileViewed = vi.fn();
vi.mock('./github-as-user.js', () => ({
  commentOnDiff: (...args: unknown[]) => commentOnDiff(...args),
  replyToReviewComment: (...args: unknown[]) => replyToReviewComment(...args),
  setThreadResolved: (...args: unknown[]) => setThreadResolved(...args),
  setFileViewed: (...args: unknown[]) => setFileViewed(...args),
}));

const { FilesActionError, runFilesAction } = await import('./dashboard-files-actions.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const SESSION = { login: 'oskr814', token: 'gho_user' };
const SHA = 'b'.repeat(40);
const FILES = {
  fetchedAt: '', prId: 'PR_1', headSha: SHA, baseSha: 'c'.repeat(40),
  files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 1, patch: '' }],
  threads: [{ id: 'PRRT_1', path: 'src/a.ts', subject: 'line' as const, side: 'RIGHT' as const, line: 3, startLine: null, originalLine: 3, isResolved: false, isOutdated: false, url: '', comments: [{ id: 77, author: 'ana', body: 'x', createdAt: '', url: '' }] }],
};
const run = (body: Record<string, unknown>) => runFilesAction(ENTRY, 904, FILES, SESSION, body);

beforeEach(() => {
  for (const mock of [commentOnDiff, replyToReviewComment, setThreadResolved, setFileViewed]) mock.mockReset().mockResolvedValue({ id: 1, url: 'u' });
});

describe('runFilesAction', () => {
  it('comments a line, a range or the file, as the person', async () => {
    await run({ action: 'comment', path: 'src/a.ts', commitId: SHA, side: 'RIGHT', line: 5, startLine: 3, text: ' ok ' });
    expect(commentOnDiff).toHaveBeenCalledWith('gho_user', 'acme/product', 904, { path: 'src/a.ts', commitId: SHA, subject: 'line', side: 'RIGHT', line: 5, startLine: 3 }, 'ok');
    await run({ action: 'comment', path: 'src/a.ts', commitId: SHA, subject: 'file', text: 'todo el archivo' });
    expect(commentOnDiff).toHaveBeenLastCalledWith('gho_user', 'acme/product', 904, { path: 'src/a.ts', commitId: SHA, subject: 'file' }, 'todo el archivo');
  });

  it("refuses what isn't this PR's or isn't a line", async () => {
    await expect(run({ action: 'comment', path: '.env', commitId: SHA, side: 'RIGHT', line: 1, text: 'x' })).rejects.toThrow(FilesActionError);
    await expect(run({ action: 'comment', path: 'src/a.ts', commitId: 'HEAD', side: 'RIGHT', line: 1, text: 'x' })).rejects.toThrow('commit');
    await expect(run({ action: 'comment', path: 'src/a.ts', commitId: SHA, side: 'UP', line: 1, text: 'x' })).rejects.toThrow('línea');
    await expect(run({ action: 'comment', path: 'src/a.ts', commitId: SHA, side: 'RIGHT', line: 2, startLine: 5, text: 'x' })).rejects.toThrow('línea');
    await expect(run({ action: 'comment', path: 'src/a.ts', commitId: SHA, side: 'RIGHT', line: 2, text: '  ' })).rejects.toThrow('falta');
    await expect(run({ action: 'reply', commentId: 5, text: 'x' })).rejects.toThrow('no es de este PR');
    await expect(run({ action: 'resolve', threadId: 'PRRT_otro' })).rejects.toThrow('no es de este PR');
    await expect(run({ action: 'borrar' })).rejects.toThrow('no existe');
    expect(commentOnDiff).not.toHaveBeenCalled();
  });

  it('replies, resolves or reopens, and marks a file viewed', async () => {
    await run({ action: 'reply', commentId: 77, text: 'dale' });
    expect(replyToReviewComment).toHaveBeenCalledWith('gho_user', 'acme/product', 904, 77, 'dale');
    await run({ action: 'resolve', threadId: 'PRRT_1' });
    await run({ action: 'resolve', threadId: 'PRRT_1', resolved: false });
    expect(setThreadResolved.mock.calls).toEqual([['gho_user', 'acme/product', 'PRRT_1', true], ['gho_user', 'acme/product', 'PRRT_1', false]]);
    await run({ action: 'viewed', path: 'src/a.ts', viewed: true });
    expect(setFileViewed).toHaveBeenCalledWith('gho_user', 'acme/product', 'PR_1', 'src/a.ts', true);
  });
});
