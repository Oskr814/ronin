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
  LABEL_BUG: 'bugfix',
  LABEL_MANAGED: 'valeria',
}));

const recordSlicePr = vi.fn();
const markSliceMerged = vi.fn();
const hasRemainingSlices = vi.fn();
const seedSingleSlice = vi.fn();
vi.mock('./checklist.js', () => ({
  recordSlicePr: (...args: unknown[]) => recordSlicePr(...args),
  markSliceMerged: (...args: unknown[]) => markSliceMerged(...args),
  hasRemainingSlices: (...args: unknown[]) => hasRemainingSlices(...args),
  seedSingleSlice: (...args: unknown[]) => seedSingleSlice(...args),
}));

const hasEvidenceComment = vi.fn();
const postEvidenceComment = vi.fn();
const addReaction = vi.fn();
const mergePullRequest = vi.fn();
const incrementAttemptCount = vi.fn();
const setIssueState = vi.fn();
const getPullRequestStatus = vi.fn();
const addIssueLabel = vi.fn();
const listAssignedBugIssues = vi.fn();
vi.mock('./github.js', () => ({
  hasEvidenceComment: (...args: unknown[]) => hasEvidenceComment(...args),
  postEvidenceComment: (...args: unknown[]) => postEvidenceComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  incrementAttemptCount: (...args: unknown[]) => incrementAttemptCount(...args),
  setIssueState: (...args: unknown[]) => setIssueState(...args),
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
  addIssueLabel: (...args: unknown[]) => addIssueLabel(...args),
  listAssignedBugIssues: (...args: unknown[]) => listAssignedBugIssues(...args),
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

const { processSlicePr, agentTaskFor, discoverAssignedBugs } = await import('./tick.js');

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
  hasRemainingSlices.mockResolvedValue(true); // preserves pre-existing merge test behavior by default
  listAssignedBugIssues.mockResolvedValue([]);
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

describe('agentTaskFor', () => {
  it('routes to implement-slice for a tracking issue without the bugfix label', () => {
    expect(agentTaskFor(issue({ labels: [] }), 2, 'Tabla de citas')).toEqual({
      type: 'implement-slice', issueNumber: 228, sliceIndex: 2, sliceTitle: 'Tabla de citas',
    });
  });

  it('routes to fix-bug for an issue labeled bugfix', () => {
    expect(agentTaskFor(issue({ labels: ['bugfix'] }), 0, 'Fix — Login redirects to 404')).toEqual({
      type: 'fix-bug', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix — Login redirects to 404',
    });
  });
});

describe('processSlicePr — same-tick done transition on merge', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  it('marks the issue done in the same tick when the merged slice was the last one', async () => {
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
    hasRemainingSlices.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(setIssueState).toHaveBeenCalledWith(228, 'done');
  });

  it('does not mark done while another slice is still pending', async () => {
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
    hasRemainingSlices.mockResolvedValue(true);

    await processSlicePr(issue(), bottomPr, true);

    expect(setIssueState).not.toHaveBeenCalledWith(228, 'done');
  });
});

describe('discoverAssignedBugs', () => {
  it('labels, seeds, and starts a bug issue not yet valeria-managed', async () => {
    listAssignedBugIssues.mockResolvedValue([{ number: 500, title: 'Login redirects to 404' }]);

    await discoverAssignedBugs();

    expect(addIssueLabel).toHaveBeenCalledWith(500, 'valeria');
    expect(seedSingleSlice).toHaveBeenCalledWith(500, 'Fix — Login redirects to 404');
    expect(setIssueState).toHaveBeenCalledWith(500, 'in-progress');
  });

  it('does nothing when there are no newly-assigned bug issues', async () => {
    listAssignedBugIssues.mockResolvedValue([]);

    await discoverAssignedBugs();

    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(seedSingleSlice).not.toHaveBeenCalled();
    expect(setIssueState).not.toHaveBeenCalled();
  });
});
