import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
}));

const listAllOpenExternalPrs = vi.fn();
const listBotOpenReviewThreads = vi.fn();
vi.mock('./github.js', () => ({
  listAllOpenExternalPrs: (...args: unknown[]) => listAllOpenExternalPrs(...args),
  listBotOpenReviewThreads: (...args: unknown[]) => listBotOpenReviewThreads(...args),
}));

const getLastReviewedSha = vi.fn();
const pruneLastReviewedSha = vi.fn();
vi.mock('./local-state.js', () => ({
  getLastReviewedSha: (...args: unknown[]) => getLastReviewedSha(...args),
  pruneLastReviewedSha: (...args: unknown[]) => pruneLastReviewedSha(...args),
}));

import { findPrsNeedingReview } from './external-review.js';

beforeEach(() => {
  listAllOpenExternalPrs.mockReset().mockResolvedValue([]);
  listBotOpenReviewThreads.mockReset().mockResolvedValue([]);
  getLastReviewedSha.mockReset().mockResolvedValue(undefined);
  pruneLastReviewedSha.mockReset().mockResolvedValue(undefined);
});

describe('findPrsNeedingReview', () => {
  it('includes a PR with no prior recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([{ number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' }]);
    getLastReviewedSha.mockResolvedValue(undefined);

    const result = await findPrsNeedingReview();

    expect(result).toEqual([{ prNumber: 10, headRefName: 'feature/x', headSha: 'sha-a', openThreads: [] }]);
  });

  it('includes a PR whose head SHA changed since the last recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([{ number: 10, headRefName: 'feature/x', headRefOid: 'sha-b' }]);
    getLastReviewedSha.mockResolvedValue('sha-a');

    const result = await findPrsNeedingReview();

    expect(result).toHaveLength(1);
    expect(result[0].headSha).toBe('sha-b');
  });

  it('excludes a PR whose head SHA matches the last recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([{ number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' }]);
    getLastReviewedSha.mockResolvedValue('sha-a');

    const result = await findPrsNeedingReview();

    expect(result).toEqual([]);
  });

  it('does not fetch review threads for a PR it excludes', async () => {
    listAllOpenExternalPrs.mockResolvedValue([{ number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' }]);
    getLastReviewedSha.mockResolvedValue('sha-a');

    await findPrsNeedingReview();

    expect(listBotOpenReviewThreads).not.toHaveBeenCalled();
  });

  it('attaches the bot\'s open review threads to a candidate, using config.githubLogin', async () => {
    listAllOpenExternalPrs.mockResolvedValue([{ number: 10, headRefName: 'feature/x', headRefOid: 'sha-b' }]);
    getLastReviewedSha.mockResolvedValue('sha-a');
    listBotOpenReviewThreads.mockResolvedValue([{ id: 'T1', body: 'old finding' }]);

    const result = await findPrsNeedingReview();

    expect(listBotOpenReviewThreads).toHaveBeenCalledWith(10, 'ronin');
    expect(result[0].openThreads).toEqual([{ id: 'T1', body: 'old finding' }]);
  });

  it('handles multiple PRs independently', async () => {
    listAllOpenExternalPrs.mockResolvedValue([
      { number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' },
      { number: 11, headRefName: 'feature/y', headRefOid: 'sha-c' },
    ]);
    getLastReviewedSha.mockImplementation(async (prNumber: number) => (prNumber === 10 ? 'sha-a' : undefined));

    const result = await findPrsNeedingReview();

    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(11);
  });

  it('keeps going when one PR fails, still returning the other candidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([
      { number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' },
      { number: 11, headRefName: 'feature/y', headRefOid: 'sha-b' },
      { number: 12, headRefName: 'feature/z', headRefOid: 'sha-c' },
    ]);
    listBotOpenReviewThreads.mockImplementation(async (prNumber: number) => {
      if (prNumber === 11) throw new Error('GraphQL flaked');
      return [];
    });

    const result = await findPrsNeedingReview();

    expect(result.map((c) => c.prNumber)).toEqual([10, 12]);
  });

  it('prunes local-state entries for PRs that are no longer open', async () => {
    listAllOpenExternalPrs.mockResolvedValue([
      { number: 10, headRefName: 'feature/x', headRefOid: 'sha-a' },
      { number: 11, headRefName: 'feature/y', headRefOid: 'sha-b' },
    ]);

    await findPrsNeedingReview();

    expect(pruneLastReviewedSha).toHaveBeenCalledWith([10, 11]);
  });
});
