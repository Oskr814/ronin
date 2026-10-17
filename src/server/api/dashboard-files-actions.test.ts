import { describe, it, expect, vi, beforeEach } from 'vitest';

const commentOnDiff = vi.fn();
const replyToReviewComment = vi.fn();
const setThreadResolved = vi.fn();
const setFileViewed = vi.fn();
const pendingReview = vi.fn();
const startReview = vi.fn();
const addReviewThread = vi.fn();
const addReviewReply = vi.fn();
const editReviewComment = vi.fn();
const deleteReviewComment = vi.fn();
const submitReview = vi.fn();
const discardReview = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('./github-as-user.js', () => ({
  pendingReview: (...args: unknown[]) => pendingReview(...args),
  startReview: (...args: unknown[]) => startReview(...args),
  addReviewThread: (...args: unknown[]) => addReviewThread(...args),
  addReviewReply: (...args: unknown[]) => addReviewReply(...args),
  editReviewComment: (...args: unknown[]) => editReviewComment(...args),
  deleteReviewComment: (...args: unknown[]) => deleteReviewComment(...args),
  submitReview: (...args: unknown[]) => submitReview(...args),
  discardReview: (...args: unknown[]) => discardReview(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
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
  fetchedAt: '', prId: 'PR_1', author: 'ronin-agent', headSha: SHA, baseSha: 'c'.repeat(40),
  files: [{ path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 1, patch: '' }],
  threads: [{ id: 'PRRT_1', path: 'src/a.ts', subject: 'line' as const, side: 'RIGHT' as const, line: 3, startLine: null, originalLine: 3, isResolved: false, isOutdated: false, url: '', comments: [{ id: 77, author: 'ana', body: 'x', createdAt: '', url: '' }] }],
};
const run = (body: Record<string, unknown>, files = FILES) => runFilesAction(ENTRY, 904, files, SESSION, body, 'ronin-agent');
const PENDING = { id: 'PRR_1', threads: [{ id: 'PRRT_9', path: 'src/a.ts', subject: 'line', side: 'RIGHT', line: 4, startLine: null, originalLine: 4, isNew: true, comments: [{ nodeId: 'PRRC_1', id: 9, body: 'b', createdAt: '' }] }] };

beforeEach(() => {
  for (const mock of [commentOnDiff, replyToReviewComment, setThreadResolved, setFileViewed, addReviewThread, addReviewReply, editReviewComment, deleteReviewComment, discardReview, commentOnIssue]) mock.mockReset().mockResolvedValue({ id: 1, url: 'u' });
  pendingReview.mockReset().mockResolvedValue(null);
  startReview.mockReset().mockResolvedValue('PRR_new');
  submitReview.mockReset().mockResolvedValue({ url: 'https://github.com/acme/product/pull/904#pullrequestreview-1' });
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

  it('starts the pending review on the commit in view, or adds to the one there is', async () => {
    await run({ action: 'comment', review: true, path: 'src/a.ts', commitId: SHA, side: 'RIGHT', line: 5, text: 'uno' });
    expect(startReview).toHaveBeenCalledWith('gho_user', 'acme/product', 'PR_1', SHA);
    expect(addReviewThread).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRR_new', { path: 'src/a.ts', commitId: SHA, subject: 'line', side: 'RIGHT', line: 5 }, 'uno');
    pendingReview.mockResolvedValue(PENDING);
    await run({ action: 'reply', review: true, commentId: 77, text: 'dos' });
    expect(startReview).toHaveBeenCalledTimes(1);
    expect(addReviewReply).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRR_1', 'PRRT_1', 'dos');
    expect(commentOnDiff).not.toHaveBeenCalled();
  });

  it('edits and deletes only what is in the person’s review', async () => {
    pendingReview.mockResolvedValue(PENDING);
    await run({ action: 'pending-edit', commentId: 'PRRC_1', text: 'mejor' });
    expect(editReviewComment).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRRC_1', 'mejor');
    await run({ action: 'pending-delete', commentId: 'PRRC_1' });
    expect(deleteReviewComment).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRRC_1');
    await expect(run({ action: 'pending-delete', commentId: 'PRRC_otro' })).rejects.toThrow('no está en tu revisión');
    await run({ action: 'discard' });
    expect(discardReview).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRR_1');
    pendingReview.mockResolvedValue(null);
    await expect(run({ action: 'discard' })).rejects.toThrow('no tenés');
  });

  it('sends the pending review, and asks ronin for /fix-comments after when told to', async () => {
    pendingReview.mockResolvedValue(PENDING);
    const sent = await run({ action: 'submit', event: 'REQUEST_CHANGES', text: ' dos cosas ', commitId: SHA, fixComments: true });
    expect(submitReview).toHaveBeenCalledWith('gho_user', 'acme/product', { prId: 'PR_1', commitId: SHA, pendingId: 'PRR_1', event: 'REQUEST_CHANGES', body: 'dos cosas' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 904, '@ronin-agent /fix-comments');
    expect(sent).toEqual({ url: 'https://github.com/acme/product/pull/904#pullrequestreview-1', fixUrl: 'u' });
  });

  it('approves with no pending review, and never asks ronin on a PR that is not its own', async () => {
    await run({ action: 'submit', event: 'APPROVE', fixComments: true }, { ...FILES, author: 'valeria' });
    expect(submitReview).toHaveBeenCalledWith('gho_user', 'acme/product', { prId: 'PR_1', commitId: SHA, event: 'APPROVE', body: '' });
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  it("refuses what GitHub would: approving one's own PR, an empty comment review, an unknown event", async () => {
    await expect(run({ action: 'submit', event: 'APPROVE' }, { ...FILES, author: 'Oskr814' })).rejects.toThrow('tu propio PR');
    await expect(run({ action: 'submit', event: 'COMMENT', text: ' ' })).rejects.toThrow('nada para mandar');
    await expect(run({ action: 'submit', event: 'MERGE' })).rejects.toThrow('falta');
    // Commenting on one's own PR is fine.
    await run({ action: 'submit', event: 'COMMENT', text: 'nota' }, { ...FILES, author: 'oskr814' });
    expect(submitReview).toHaveBeenCalledTimes(1);
  });
});
