import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
}));

const listAllOpenExternalPrs = vi.fn();
const listBotOpenReviewThreads = vi.fn();
const listExternalOpenReviewThreads = vi.fn();
vi.mock('./github.js', () => ({
  listAllOpenExternalPrs: (...args: unknown[]) => listAllOpenExternalPrs(...args),
  listBotOpenReviewThreads: (...args: unknown[]) => listBotOpenReviewThreads(...args),
  listExternalOpenReviewThreads: (...args: unknown[]) => listExternalOpenReviewThreads(...args),
}));

const getLastReviewedSha = vi.fn();
const pruneLastReviewedSha = vi.fn();
vi.mock('./local-state.js', () => ({
  getLastReviewedSha: (...args: unknown[]) => getLastReviewedSha(...args),
  pruneLastReviewedSha: (...args: unknown[]) => pruneLastReviewedSha(...args),
}));

const findUnprocessedMentions = vi.fn();
const findTrustedFixCommentsCommand = vi.fn();
vi.mock('./mentions.js', () => ({
  findUnprocessedMentions: (...args: unknown[]) => findUnprocessedMentions(...args),
  findTrustedFixCommentsCommand: (...args: unknown[]) => findTrustedFixCommentsCommand(...args),
}));

import { findPrsNeedingReview } from './external-review.js';

function extPr(overrides: Partial<{ number: number; headRefName: string; headRefOid: string; isCrossRepository: boolean }> = {}) {
  return { number: 10, headRefName: 'feature/x', headRefOid: 'sha-a', isCrossRepository: false, ...overrides };
}

beforeEach(() => {
  listAllOpenExternalPrs.mockReset().mockResolvedValue([]);
  listBotOpenReviewThreads.mockReset().mockResolvedValue([]);
  listExternalOpenReviewThreads.mockReset().mockResolvedValue([]);
  getLastReviewedSha.mockReset().mockResolvedValue(undefined);
  pruneLastReviewedSha.mockReset().mockResolvedValue(undefined);
  findUnprocessedMentions.mockReset().mockResolvedValue([]);
  findTrustedFixCommentsCommand.mockReset().mockResolvedValue([]);
});

describe('findPrsNeedingReview — reviewCandidates (read-only path, unchanged behavior)', () => {
  it('includes a PR with no prior recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue(undefined);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toEqual([{ prNumber: 10, headRefName: 'feature/x', headSha: 'sha-a', openThreads: [], mentions: [] }]);
  });

  it('includes a PR with an unprocessed @mention even though its head SHA is unchanged', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue('sha-a');
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorAssociation: 'NONE' }]);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toHaveLength(1);
    expect(reviewCandidates[0].mentions).toEqual([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorAssociation: 'NONE' }]);
  });

  it('fetches review threads for a PR included only because of a mention', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue('sha-a');
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorAssociation: 'NONE' }]);

    await findPrsNeedingReview();

    expect(listBotOpenReviewThreads).toHaveBeenCalledWith(10, 'ronin');
  });

  it('excludes a PR whose head SHA matches the last recorded review and has no mention', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue('sha-a');

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toEqual([]);
  });

  it('includes a PR whose head SHA changed since the last recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ headRefOid: 'sha-b' })]);
    getLastReviewedSha.mockResolvedValue('sha-a');

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toHaveLength(1);
    expect(reviewCandidates[0].headSha).toBe('sha-b');
  });

  it('keeps going when one PR fails, still returning the other candidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([
      extPr({ number: 10 }),
      extPr({ number: 11, headRefName: 'feature/y' }),
      extPr({ number: 12, headRefName: 'feature/z' }),
    ]);
    listBotOpenReviewThreads.mockImplementation(async (prNumber: number) => {
      if (prNumber === 11) throw new Error('GraphQL flaked');
      return [];
    });

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates.map((c) => c.prNumber)).toEqual([10, 12]);
  });

  it('prunes local-state entries for PRs that are no longer open', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ number: 10 }), extPr({ number: 11, headRefName: 'feature/y' })]);

    await findPrsNeedingReview();

    expect(pruneLastReviewedSha).toHaveBeenCalledWith([10, 11]);
  });
});

describe('findPrsNeedingReview — trustedFixCandidates', () => {
  it('routes a non-fork PR with a trusted /fix-comments command to trustedFixCandidates, not reviewCandidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: false })]);
    findTrustedFixCommentsCommand.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' }]);
    listExternalOpenReviewThreads.mockResolvedValue([{ id: 'T1', body: 'finding from Copilot' }]);

    const { reviewCandidates, trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([
      { prNumber: 10, headRefName: 'feature/x', trigger: [{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' }], openThreads: [{ id: 'T1', body: 'finding from Copilot' }] },
    ]);
    expect(reviewCandidates).toEqual([]);
  });

  it('never routes a fork PR to trustedFixCandidates, even with a trusted command', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: true })]);
    findTrustedFixCommentsCommand.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorAssociation: 'MEMBER' }]);

    const { trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([]);
    expect(findTrustedFixCommentsCommand).not.toHaveBeenCalled();
  });

  it('does not call findTrustedFixCommentsCommand for a fork PR at all', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: true })]);

    await findPrsNeedingReview();

    expect(findTrustedFixCommentsCommand).not.toHaveBeenCalled();
  });

  it('leaves a non-fork PR with no trusted command out of trustedFixCandidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: false })]);
    findTrustedFixCommentsCommand.mockResolvedValue([]);

    const { trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([]);
  });
});
