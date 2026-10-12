import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
}));

const listAllOpenExternalPrs = vi.fn();
const listBotReviewThreads = vi.fn();
const listAllOpenReviewThreads = vi.fn();
const getLastReviewedShaFromGitHub = vi.fn();
vi.mock('./github.js', () => ({
  listAllOpenExternalPrs: (...args: unknown[]) => listAllOpenExternalPrs(...args),
  listBotReviewThreads: (...args: unknown[]) => listBotReviewThreads(...args),
  listAllOpenReviewThreads: (...args: unknown[]) => listAllOpenReviewThreads(...args),
  getLastReviewedShaFromGitHub: (...args: unknown[]) => getLastReviewedShaFromGitHub(...args),
}));

const isCommitAvailable = vi.fn();
const fetchCommit = vi.fn();
const pruneReviewedPins = vi.fn();
vi.mock('./worktree.js', () => ({
  isCommitAvailable: (...args: unknown[]) => isCommitAvailable(...args),
  fetchCommit: (...args: unknown[]) => fetchCommit(...args),
  pruneReviewedPins: (...args: unknown[]) => pruneReviewedPins(...args),
}));

vi.mock('./logger.js', () => ({ log: { info: vi.fn(), error: vi.fn(), metric: vi.fn() } }));

const getLastReviewedSha = vi.fn();
const pruneLastReviewedSha = vi.fn();
vi.mock('./local-state.js', () => ({
  getLastReviewedSha: (...args: unknown[]) => getLastReviewedSha(...args),
  pruneLastReviewedSha: (...args: unknown[]) => pruneLastReviewedSha(...args),
}));

const findUnprocessedMentions = vi.fn();
vi.mock('./mentions.js', async (importOriginal) => ({
  findUnprocessedMentions: (...args: unknown[]) => findUnprocessedMentions(...args),
  trustedFixCommands: (await importOriginal<typeof import('./mentions.js')>()).trustedFixCommands,
}));

import { findPrsNeedingReview } from './external-review.js';

function extPr(overrides: Partial<{ number: number; headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }> = {}) {
  return { number: 10, headRefName: 'feature/x', headRefOid: 'sha-a', baseRefName: 'main', isCrossRepository: false, ...overrides };
}

beforeEach(() => {
  listAllOpenExternalPrs.mockReset().mockResolvedValue([]);
  listBotReviewThreads.mockReset().mockResolvedValue([]);
  getLastReviewedShaFromGitHub.mockReset().mockResolvedValue(undefined);
  isCommitAvailable.mockReset().mockResolvedValue(true);
  fetchCommit.mockReset().mockResolvedValue(undefined);
  pruneReviewedPins.mockReset().mockResolvedValue(undefined);
  listAllOpenReviewThreads.mockReset().mockResolvedValue([]);
  getLastReviewedSha.mockReset().mockResolvedValue(undefined);
  pruneLastReviewedSha.mockReset().mockResolvedValue(undefined);
  findUnprocessedMentions.mockReset().mockResolvedValue([]);
});

describe('findPrsNeedingReview — reviewCandidates (read-only path, unchanged behavior)', () => {
  it('includes a PR with no prior recorded review', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue(undefined);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toEqual([
      { prNumber: 10, headRefName: 'feature/x', headSha: 'sha-a', baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true },
    ]);
  });

  it('includes a PR with an unprocessed @mention even though its head SHA is unchanged', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue('sha-a');
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorLogin: 'someone' }]);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates).toHaveLength(1);
    expect(reviewCandidates[0].mentions).toEqual([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorLogin: 'someone' }]);
  });

  it('fetches review threads for a PR included only because of a mention', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    getLastReviewedSha.mockResolvedValue('sha-a');
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0, authorLogin: 'someone' }]);

    await findPrsNeedingReview();

    expect(listBotReviewThreads).toHaveBeenCalledWith(10, 'ronin');
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

  it('splits the thread history into the open threads the run can resolve', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr()]);
    const open = { id: 'T1', body: 'abierto', url: 'u1', isResolved: false };
    const resolved = { id: 'T2', body: 'resuelto', url: 'u2', isResolved: true };
    listBotReviewThreads.mockResolvedValue([open, resolved]);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates[0].threadHistory).toEqual([open, resolved]);
    expect(reviewCandidates[0].openThreads).toEqual([{ id: 'T1', body: 'abierto', url: 'u1' }]);
  });

  it('lets the review execute code only on a branch of this same repo, never on a fork', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ number: 10 }), extPr({ number: 11, isCrossRepository: true })]);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates.map((c) => [c.prNumber, c.canExecute])).toEqual([[10, true], [11, false]]);
  });

  describe('previousSha', () => {
    it('comes from the review marker on GitHub first', async () => {
      listAllOpenExternalPrs.mockResolvedValue([extPr({ headRefOid: 'sha-c' })]);
      getLastReviewedSha.mockResolvedValue('sha-a');
      getLastReviewedShaFromGitHub.mockResolvedValue('sha-b');

      const { reviewCandidates } = await findPrsNeedingReview();

      expect(getLastReviewedShaFromGitHub).toHaveBeenCalledWith(10, 'ronin');
      expect(reviewCandidates[0].previousSha).toBe('sha-b');
    });

    it('falls back to the local cache when GitHub has no marked review', async () => {
      listAllOpenExternalPrs.mockResolvedValue([extPr({ headRefOid: 'sha-c' })]);
      getLastReviewedSha.mockResolvedValue('sha-a');

      const { reviewCandidates } = await findPrsNeedingReview();

      expect(reviewCandidates[0].previousSha).toBe('sha-a');
    });

    it('is absent on a PR never reviewed', async () => {
      listAllOpenExternalPrs.mockResolvedValue([extPr()]);

      const { reviewCandidates } = await findPrsNeedingReview();

      expect(reviewCandidates[0]).not.toHaveProperty('previousSha');
    });

    it('fetches a missing commit once, and goes full review when it is still missing', async () => {
      listAllOpenExternalPrs.mockResolvedValue([extPr({ headRefOid: 'sha-c' }), extPr({ number: 11, headRefOid: 'sha-d' })]);
      getLastReviewedShaFromGitHub.mockImplementation(async (n: number) => (n === 10 ? 'gone' : 'late'));
      const fetched = new Set<string>();
      fetchCommit.mockImplementation(async (sha: string) => void fetched.add(sha));
      isCommitAvailable.mockImplementation(async (sha: string) => sha === 'late' && fetched.has('late'));

      const { reviewCandidates } = await findPrsNeedingReview();

      expect(fetchCommit).toHaveBeenCalledWith('gone');
      expect(reviewCandidates[0]).not.toHaveProperty('previousSha');
      expect(reviewCandidates[1].previousSha).toBe('late');
    });
  });

  it('keeps going when one PR fails, still returning the other candidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([
      extPr({ number: 10 }),
      extPr({ number: 11, headRefName: 'feature/y' }),
      extPr({ number: 12, headRefName: 'feature/z' }),
    ]);
    listBotReviewThreads.mockImplementation(async (prNumber: number) => {
      if (prNumber === 11) throw new Error('GraphQL flaked');
      return [];
    });

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates.map((c) => c.prNumber)).toEqual([10, 12]);
  });

  it('prunes the reviewed-SHA pins of PRs that are no longer open', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ number: 7 })]);

    await findPrsNeedingReview();

    expect(pruneReviewedPins).toHaveBeenCalledWith([7]);
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
    findUnprocessedMentions.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);
    listAllOpenReviewThreads.mockResolvedValue([{ id: 'T1', body: 'finding from Copilot' }]);

    const { reviewCandidates, trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([
      { prNumber: 10, headRefName: 'feature/x', trigger: [{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }], openThreads: [{ id: 'T1', body: 'finding from Copilot' }] },
    ]);
    expect(reviewCandidates).toEqual([]);
    expect(listAllOpenReviewThreads).toHaveBeenCalledWith(10);
  });

  it('includes threads the bot opened itself in an earlier automatic review pass', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: false })]);
    findUnprocessedMentions.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);
    listAllOpenReviewThreads.mockResolvedValue([{ id: 'T1', body: 'finding ronin itself posted earlier' }]);

    const { trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates[0].openThreads).toEqual([{ id: 'T1', body: 'finding ronin itself posted earlier' }]);
  });

  it('never routes a fork PR to trustedFixCandidates, even with a trusted command', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: true })]);
    findUnprocessedMentions.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);

    const { trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([]);
    expect(listAllOpenReviewThreads).not.toHaveBeenCalled();
  });

  it('treats a /fix-comments mention on a fork PR as a plain review request', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: true })]);
    findUnprocessedMentions.mockResolvedValue([{ id: 9, kind: 'issue', body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }]);

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates.map((c) => c.mentions.map((m) => m.id))).toEqual([[9]]);
  });

  it('lists each PR\'s mentions only once', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ number: 10 }), extPr({ number: 11 })]);

    await findPrsNeedingReview();

    expect(findUnprocessedMentions.mock.calls).toEqual([[10], [11]]);
  });

  it('keeps the PRs\' own order when they finish out of order', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ number: 10 }), extPr({ number: 11 })]);
    listBotReviewThreads.mockImplementation(async (n: number) => {
      if (n === 10) await new Promise((r) => setTimeout(r, 5));
      return [];
    });

    const { reviewCandidates } = await findPrsNeedingReview();

    expect(reviewCandidates.map((c) => c.prNumber)).toEqual([10, 11]);
  });

  it('leaves a non-fork PR with no trusted command out of trustedFixCandidates', async () => {
    listAllOpenExternalPrs.mockResolvedValue([extPr({ isCrossRepository: false })]);

    const { trustedFixCandidates } = await findPrsNeedingReview();

    expect(trustedFixCandidates).toEqual([]);
  });
});
