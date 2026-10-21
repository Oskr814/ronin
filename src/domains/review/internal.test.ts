import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestStatus } from '@platform/github/github.js';
import type { ReviewFinding } from './output.js';

const runAgentTask = vi.fn();
vi.mock('@platform/agents/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));
const getPullRequestStatus = vi.fn();
const setReviewStatus = vi.fn();
const listAllOpenRoninPrs = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
  listAllOpenRoninPrs: (...args: unknown[]) => listAllOpenRoninPrs(...args),
  setReviewStatus: (...args: unknown[]) => setReviewStatus(...args),
}));
const isCommitAvailable = vi.fn();
const fetchCommit = vi.fn();
const pinReviewedSha = vi.fn();
vi.mock('@platform/git/worktree.js', () => ({
  isCommitAvailable: (...args: unknown[]) => isCommitAvailable(...args),
  fetchCommit: (...args: unknown[]) => fetchCommit(...args),
  pinReviewedSha: (...args: unknown[]) => pinReviewedSha(...args),
}));
let reviews: { reviewed: Record<string, string>; failed: Record<string, string>; seeded: boolean };
const setInternalReview = vi.fn();
const seedInternalReviews = vi.fn(async (open: Array<{ number: number; headRefOid: string }>) => {
  for (const pr of open) reviews.reviewed[pr.number] ??= pr.headRefOid;
  reviews.seeded = true;
});
vi.mock('@platform/state/local-state.js', () => ({
  seedInternalReviews: (open: Array<{ number: number; headRefOid: string }>) => seedInternalReviews(open),
  getInternalReviews: async () => reviews,
  setInternalReview: (...args: unknown[]) => setInternalReview(...args),
}));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn(), metric: vi.fn() } }));
const reviewPr = vi.fn();
vi.mock('./publish.js', () => ({ reviewPr: (...args: unknown[]) => reviewPr(...args) }));
vi.mock('./prompts.js', () => ({ reviewTask: (task: unknown) => task }));

const { internalReviewDue, runInternalReview } = await import('./internal.js');

const pr = { number: 40, headRefName: 'ronin/7/slice-1', headRefOid: 'head1', baseRefName: 'main' } as PullRequestStatus;

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/a.ts', line: 3, type: 'bug', severity: 'important', category: 'Lógica', title: 'Algo falla',
    impact: 'Falla.', evidence: [], verification: { status: 'reasoned' }, affectedCode: 'x', ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reviews = { reviewed: {}, failed: {}, seeded: true };
  reviewPr.mockResolvedValue({ findings: [], scope: { mode: 'full' }, agentMs: 1 });
  getPullRequestStatus.mockResolvedValue({ headRefOid: 'head2' });
  isCommitAvailable.mockResolvedValue(true);
  pinReviewedSha.mockResolvedValue(undefined);
});

describe('internalReviewDue', () => {
  it('is due until the head is reviewed, and not again on a head it failed on', async () => {
    expect(await internalReviewDue(pr)).toBe(true);
    reviews = { reviewed: { 40: 'head1' }, failed: {}, seeded: true };
    expect(await internalReviewDue(pr)).toBe(false);
    reviews = { reviewed: { 40: 'head0' }, failed: { 40: 'head1' }, seeded: true };
    expect(await internalReviewDue(pr)).toBe(false);
    reviews = { reviewed: { 40: 'head0' }, failed: { 40: 'head0' }, seeded: true };
    expect(await internalReviewDue(pr)).toBe(true);
  });

  it('the first time, counts the PRs already open as reviewed on their head', async () => {
    reviews = { reviewed: {}, failed: {}, seeded: false };
    listAllOpenRoninPrs.mockResolvedValue([{ number: 40, headRefOid: 'head1' }, { number: 41, headRefOid: 'h41' }]);

    expect(await internalReviewDue(pr)).toBe(false);
    expect(await internalReviewDue({ number: 41, headRefOid: 'h41b' })).toBe(true);
    expect(listAllOpenRoninPrs).toHaveBeenCalledTimes(1);
  });
});

describe('runInternalReview', () => {
  it('reviews the head as ronin\'s own, publishing nothing, and records it when there is nothing to attend', async () => {
    await runInternalReview(7, pr);

    expect(reviewPr).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 40, headSha: 'head1', own: true, threadHistory: [], mentions: [], canExecute: true }));
    expect(reviewPr.mock.calls[0][0]).not.toHaveProperty('previousSha');
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(setInternalReview).toHaveBeenCalledWith(40, { reviewed: 'head1' });
    expect(setReviewStatus).toHaveBeenLastCalledWith(40, 'success', 'Sin hallazgos para atender', { sha: 'head1', context: 'ronin/review-interna' });
  });

  it('has ronin attend the critical and important findings and the decisions, not the minor or older ones, and records the head it ends on', async () => {
    const bug = finding();
    const decision = finding({ type: 'decision', title: '¿Es a propósito?' });
    reviewPr.mockResolvedValue({
      findings: [bug, finding({ severity: 'minor' }), finding({ origin: { kind: 'preexisting', note: 'no lo toca' } }), decision],
      scope: { mode: 'full' },
      agentMs: 1,
    });

    await runInternalReview(7, pr);

    expect(runAgentTask).toHaveBeenCalledWith({ type: 'fix-internal-review', issueNumber: 7, prNumber: 40, findings: [bug, decision] });
    expect(pinReviewedSha).toHaveBeenCalledWith(40, 'head2');
    expect(setInternalReview).toHaveBeenCalledWith(40, { reviewed: 'head2' });
    expect(setReviewStatus).toHaveBeenLastCalledWith(40, 'success', '2 hallazgos atendidos', { sha: 'head2', context: 'ronin/review-interna' });
  });

  it('reviews only what changed since the last reviewed commit, when it is still around', async () => {
    reviews = { reviewed: { 40: 'head0' }, failed: {}, seeded: true };

    await runInternalReview(7, pr);

    expect(reviewPr).toHaveBeenCalledWith(expect.objectContaining({ previousSha: 'head0' }));
  });

  it('reviews the whole PR when the last reviewed commit is gone', async () => {
    reviews = { reviewed: { 40: 'head0' }, failed: {}, seeded: true };
    isCommitAvailable.mockResolvedValue(false);

    await runInternalReview(7, pr);

    expect(fetchCommit).toHaveBeenCalledWith('head0');
    expect(reviewPr.mock.calls[0][0]).not.toHaveProperty('previousSha');
  });

  it('records a failure on the head, says so on the PR and rethrows', async () => {
    reviewPr.mockRejectedValue(new Error('timeout'));

    await expect(runInternalReview(7, pr)).rejects.toThrow('timeout');

    expect(setInternalReview).toHaveBeenCalledWith(40, { failed: 'head1' });
    expect(setReviewStatus).toHaveBeenLastCalledWith(40, 'error', expect.stringContaining('falló'), { sha: 'head1', context: 'ronin/review-interna' });
  });
});
