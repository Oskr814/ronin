import { describe, it, expect, vi, beforeEach } from 'vitest';

const pendingReview = vi.fn();
const submitReview = vi.fn();
const commentOnIssue = vi.fn();
const discardReview = vi.fn();
const closePr = vi.fn();
const closeIssue = vi.fn();
vi.mock('../../platform/github/github-as-user.js', () => ({
  pendingReview: (...args: unknown[]) => pendingReview(...args),
  submitReview: (...args: unknown[]) => submitReview(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
  discardReview: (...args: unknown[]) => discardReview(...args),
  closePr: (...args: unknown[]) => closePr(...args),
  closeIssue: (...args: unknown[]) => closeIssue(...args),
}));

const { DecisionError, decidable, runDecision } = await import('./decision.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const SESSION = { login: 'oskr814', token: 'gho_user' };
const SHA = 'b'.repeat(40);
const FILES = { fetchedAt: '', prId: 'PR_1', author: 'ronin-agent', headSha: SHA, baseSha: 'c'.repeat(40), files: [], threads: [] };
import type { Discussion } from '../../platform/github/github.js';

const PR: Discussion = { number: 918, title: 't', body: '', author: 'ronin-agent', createdAt: '', url: '', state: 'OPEN', isDraft: false, labels: [], comments: [], mergeable: 'MERGEABLE' };
const target = (pr: Partial<Discussion> = {}) => ({ prNumber: 918, issueNumber: 912, files: FILES, pr: { ...PR, ...pr } });
const run = (body: Record<string, unknown>, pr: Partial<Discussion> = {}) => runDecision(ENTRY, target(pr), SESSION, body, 'ronin-agent');
const PENDING = { id: 'PRR_1', threads: [] };

beforeEach(() => {
  pendingReview.mockReset().mockResolvedValue(null);
  submitReview.mockReset().mockResolvedValue({ url: 'review' });
  commentOnIssue.mockReset().mockResolvedValue({ id: 1, url: 'comment' });
  discardReview.mockReset().mockResolvedValue(undefined);
  closePr.mockReset().mockResolvedValue({ url: 'pr' });
  closeIssue.mockReset().mockResolvedValue({ url: 'issue' });
});

describe('decidable', () => {
  it("is for ronin's open PRs that aren't drafts", () => {
    expect(decidable(PR, 'Ronin-Agent')).toBe(true);
    expect(decidable({ ...PR, author: 'ana' }, 'ronin-agent')).toBe(false);
    expect(decidable({ ...PR, state: 'MERGED' }, 'ronin-agent')).toBe(false);
    expect(decidable({ ...PR, isDraft: true }, 'ronin-agent')).toBe(false);
  });
});

describe('runDecision', () => {
  it("refuses a PR that isn't ronin's, and a decision that doesn't exist", async () => {
    await expect(run({ decision: 'approve' }, { author: 'ana' })).rejects.toThrow(DecisionError);
    await expect(run({ decision: 'merge' })).rejects.toThrow('no existe esa decisión');
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('approves and asks ronin for the auto-merge, as the person', async () => {
    expect(await run({ decision: 'approve' })).toEqual({ url: 'review', autoMergeUrl: 'comment' });
    expect(submitReview).toHaveBeenCalledWith('gho_user', 'acme/product', { prId: 'PR_1', commitId: SHA, event: 'APPROVE', body: '' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 918, '@ronin-agent /auto-merge');
  });

  it("sends the pending comments with the approval, and leaves the auto-merge alone when it's on or can't merge", async () => {
    pendingReview.mockResolvedValue(PENDING);
    expect(await run({ decision: 'approve' }, { labels: ['ronin:auto-merge'] })).toEqual({ url: 'review' });
    expect(submitReview).toHaveBeenCalledWith('gho_user', 'acme/product', expect.objectContaining({ pendingId: 'PRR_1', event: 'APPROVE' }));
    await run({ decision: 'approve' }, { mergeable: 'CONFLICTING' });
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  it('asks for an adjustment with a mention: the review-request flow', async () => {
    expect(await run({ decision: 'adjust', text: ' sin dirección, estimá el envío ' })).toEqual({ id: 1, url: 'comment' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 918, '@ronin-agent sin dirección, estimá el envío');
    expect(submitReview).not.toHaveBeenCalled();
  });

  it('sends the line comments as a review and /fix-comments with the text, when there are some', async () => {
    pendingReview.mockResolvedValue(PENDING);
    await run({ decision: 'adjust', text: 'y un test' });
    expect(submitReview).toHaveBeenCalledWith('gho_user', 'acme/product', { prId: 'PR_1', commitId: SHA, pendingId: 'PRR_1', event: 'COMMENT', body: '' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 918, '@ronin-agent /fix-comments\n\ny un test');
    await run({ decision: 'adjust' });
    expect(commentOnIssue).toHaveBeenLastCalledWith('gho_user', 'acme/product', 918, '@ronin-agent /fix-comments');
  });

  it('refuses an empty adjustment, and one that reads as a command', async () => {
    await expect(run({ decision: 'adjust', text: '  ' })).rejects.toThrow('escribí qué debería cambiar ronin');
    await expect(run({ decision: 'adjust', text: '/auto-merge' })).rejects.toThrow('usá Acciones');
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  it('closes the PR with its reason, dropping the pending review, and the issue only when asked', async () => {
    pendingReview.mockResolvedValue(PENDING);
    expect(await run({ decision: 'close', text: 'otro enfoque' })).toEqual({ url: 'pr' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 918, 'otro enfoque');
    expect(discardReview).toHaveBeenCalledWith('gho_user', 'acme/product', 'PRR_1');
    expect(closePr).toHaveBeenCalledWith('gho_user', 'acme/product', 918);
    expect(closeIssue).not.toHaveBeenCalled();
    expect(await run({ decision: 'close', closeIssue: true })).toEqual({ url: 'pr', issueUrl: 'issue' });
    expect(closeIssue).toHaveBeenCalledWith('gho_user', 'acme/product', 912);
    expect(commentOnIssue).toHaveBeenCalledTimes(1);
  });
});
