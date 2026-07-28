import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackingIssue } from './github.js';
import type { StackedPr } from './stack.js';

const existsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
}));

vi.mock('./config.js', () => ({
  config: {
    e2eRetryLimit: 2,
    sliceAttemptLimit: 3,
    rebaseRetryLimit: 3,
    worktreeBaseRef: 'origin/main',
    productRepo: 'bmedical/bmedical',
  },
}));

const recordSlicePr = vi.fn();
const markSliceMerged = vi.fn();
vi.mock('./checklist.js', () => ({
  recordSlicePr: (...args: unknown[]) => recordSlicePr(...args),
  markSliceMerged: (...args: unknown[]) => markSliceMerged(...args),
}));

const hasEvidenceComment = vi.fn();
const postEvidenceComment = vi.fn();
const addReaction = vi.fn();
const mergePullRequest = vi.fn();
const incrementAttemptCount = vi.fn();
const setIssueState = vi.fn();
const getPullRequestStatus = vi.fn();
vi.mock('./github.js', () => ({
  hasEvidenceComment: (...args: unknown[]) => hasEvidenceComment(...args),
  postEvidenceComment: (...args: unknown[]) => postEvidenceComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  incrementAttemptCount: (...args: unknown[]) => incrementAttemptCount(...args),
  setIssueState: (...args: unknown[]) => setIssueState(...args),
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
}));

const publishEvidence = vi.fn();
vi.mock('./evidence.js', () => ({
  publishEvidence: (...args: unknown[]) => publishEvidence(...args),
  rawEvidenceUrl: (p: string) => `https://raw/${p}`,
}));

const worktreeDirFor = vi.fn();
const isBehind = vi.fn();
const attemptRebase = vi.fn();
vi.mock('./worktree.js', () => ({
  worktreeDirFor: (...args: unknown[]) => worktreeDirFor(...args),
  isBehind: (...args: unknown[]) => isBehind(...args),
  attemptRebase: (...args: unknown[]) => attemptRebase(...args),
}));

const findUnprocessedMentions = vi.fn();
vi.mock('./mentions.js', () => ({
  findUnprocessedMentions: (...args: unknown[]) => findUnprocessedMentions(...args),
}));

const runAgentTask = vi.fn();
vi.mock('./agent-task.js', () => ({
  runAgentTask: (...args: unknown[]) => runAgentTask(...args),
}));

const notifyBlocker = vi.fn();
vi.mock('./notifier.js', () => ({
  notifyBlocker: (...args: unknown[]) => notifyBlocker(...args),
}));

const { processSlicePr } = await import('./tick.js');

function issue(overrides: Partial<TrackingIssue> = {}): TrackingIssue {
  return { number: 228, title: 'Test issue', url: 'https://github.com/x/y/issues/228', labels: [], ...overrides };
}

function pr(overrides: Partial<StackedPr> = {}): StackedPr {
  return {
    number: 230,
    state: 'OPEN',
    reviewDecision: '',
    checksPassing: false,
    checksPending: false,
    mergeable: true,
    headRefName: 'valeria/228/slice-2',
    baseRefName: 'valeria/228/slice-1',
    isDraft: false,
    sliceIndex: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordSlicePr.mockResolvedValue(undefined);
  hasEvidenceComment.mockResolvedValue(true); // skip publishEvidence path
  findUnprocessedMentions.mockResolvedValue([]);
  worktreeDirFor.mockReturnValue('/tmp/worktree');
  incrementAttemptCount.mockResolvedValue(1);
  existsSync.mockReturnValue(true);
});

describe('processSlicePr — non-bottom stacked PR', () => {
  it('waits quietly when checks are pending, never escalates or runs fix-e2e', async () => {
    const stillInProgress = await processSlicePr(issue(), pr({ checksPending: true, reviewDecision: '' }), false);

    expect(stillInProgress).toBe(true);
    expect(incrementAttemptCount).not.toHaveBeenCalled();
    expect(notifyBlocker).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalled();
  });
});

describe('processSlicePr — non-bottom stacked PR (regression)', () => {
  it('still runs fix-review when changes are requested, regardless of checks', async () => {
    const stillInProgress = await processSlicePr(
      issue(),
      pr({ checksPending: true, reviewDecision: 'CHANGES_REQUESTED' }),
      false,
    );

    expect(stillInProgress).toBe(true);
    expect(runAgentTask).toHaveBeenCalledWith({ type: 'fix-review', issueNumber: 228, prNumber: 230 });
  });
});

describe('processSlicePr — bottom-of-stack PR (unchanged behavior)', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  it('merges when checks pass and review is approved', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'valeria/228/slice-1',
      checksPassing: true,
      checksPending: false,
      reviewDecision: 'APPROVED',
    });
    isBehind.mockResolvedValue(false);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledWith(229);
    expect(markSliceMerged).toHaveBeenCalledWith(228, 0);
  });

  it('escalates once e2eRetryLimit is exceeded when checks never report', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'valeria/228/slice-1',
      checksPending: true,
    });
    isBehind.mockResolvedValue(false);
    incrementAttemptCount.mockResolvedValue(3); // > e2eRetryLimit (2)

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(false);
    expect(notifyBlocker).toHaveBeenCalled();
  });
});

describe('processSlicePr — mentions found on an already-mergeable bottom PR (regression)', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  it('re-reads fresh PR state after review-request and merges in the same tick, instead of deferring', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'valeria/228/slice-1',
      checksPassing: false, // stale snapshot taken before the mention landed
      reviewDecision: '',
    });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent fijate esto', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue({ ...bottomPr, checksPassing: true, reviewDecision: 'APPROVED' });
    isBehind.mockResolvedValue(false);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'review-request', issueNumber: 228, prNumber: 229,
      mentions: [{ id: 1, kind: 'issue', body: '@valeria-agent fijate esto', reactionsEyes: 0 }],
    });
    expect(stillInProgress).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledWith(229);
  });
});
