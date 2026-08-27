import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackingIssue } from './github.js';
import type { StackedPr } from './stack.js';

const existsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
}));

const readFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFile(...args),
}));

vi.mock('./config.js', () => ({
  config: {
    e2eRetryLimit: 2,
    checksPendingRetryLimit: 60,
    sliceAttemptLimit: 3,
    rebaseRetryLimit: 3,
    worktreeBaseRef: 'origin/main',
    // Needed by runExternalReviews's runWithConcurrency call — with an
    // undefined limit the pool spawns zero lanes and silently no-ops.
    tickConcurrency: 2,
  },
  LABEL_BUG: 'bugfix',
  LABEL_MANAGED: 'ronin',
  LABEL_STACK_PRS: 'ronin:stack-prs',
}));

const activeRepo = vi.fn();
vi.mock('./repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const recordSlicePr = vi.fn();
const markSliceMerged = vi.fn();
const hasRemainingSlices = vi.fn();
const seedSingleSlice = vi.fn();
const nextUnstartedSlice = vi.fn();
const getSlices = vi.fn();
vi.mock('./checklist.js', () => ({
  recordSlicePr: (...args: unknown[]) => recordSlicePr(...args),
  markSliceMerged: (...args: unknown[]) => markSliceMerged(...args),
  hasRemainingSlices: (...args: unknown[]) => hasRemainingSlices(...args),
  seedSingleSlice: (...args: unknown[]) => seedSingleSlice(...args),
  nextUnstartedSlice: (...args: unknown[]) => nextUnstartedSlice(...args),
  getSlices: (...args: unknown[]) => getSlices(...args),
}));

const addReaction = vi.fn();
const mergePullRequest = vi.fn();
const incrementAttemptCount = vi.fn();
const setIssueState = vi.fn();
const getPullRequestStatus = vi.fn();
const addIssueLabel = vi.fn();
const listAssignedBugIssues = vi.fn();
const listExternalOpenReviewThreads = vi.fn();
const setReviewStatus = vi.fn();
vi.mock('./github.js', () => ({
  addReaction: (...args: unknown[]) => addReaction(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  incrementAttemptCount: (...args: unknown[]) => incrementAttemptCount(...args),
  setIssueState: (...args: unknown[]) => setIssueState(...args),
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
  addIssueLabel: (...args: unknown[]) => addIssueLabel(...args),
  listAssignedBugIssues: (...args: unknown[]) => listAssignedBugIssues(...args),
  listExternalOpenReviewThreads: (...args: unknown[]) => listExternalOpenReviewThreads(...args),
  setReviewStatus: (...args: unknown[]) => setReviewStatus(...args),
}));

const incrementChecksPendingCount = vi.fn();
const resetChecksPendingCount = vi.fn();
const setLastReviewedSha = vi.fn();
vi.mock('./local-state.js', () => ({
  incrementChecksPendingCount: (...args: unknown[]) => incrementChecksPendingCount(...args),
  resetChecksPendingCount: (...args: unknown[]) => resetChecksPendingCount(...args),
  setLastReviewedSha: (...args: unknown[]) => setLastReviewedSha(...args),
}));

const worktreeDirFor = vi.fn();
const isBehind = vi.fn();
const attemptRebase = vi.fn();
const removeWorktree = vi.fn();
vi.mock('./worktree.js', () => ({
  worktreeDirFor: (...args: unknown[]) => worktreeDirFor(...args),
  isBehind: (...args: unknown[]) => isBehind(...args),
  attemptRebase: (...args: unknown[]) => attemptRebase(...args),
  removeWorktree: (...args: unknown[]) => removeWorktree(...args),
}));

const findUnprocessedMentions = vi.fn();
const isFixCommentsCommand = vi.fn();
vi.mock('./mentions.js', () => ({
  findUnprocessedMentions: (...args: unknown[]) => findUnprocessedMentions(...args),
  isFixCommentsCommand: (...args: unknown[]) => isFixCommentsCommand(...args),
}));

const runAgentTask = vi.fn();
vi.mock('./agent-task.js', () => ({
  runAgentTask: (...args: unknown[]) => runAgentTask(...args),
}));

const notifyBlocker = vi.fn();
vi.mock('./notifier.js', () => ({
  notifyBlocker: (...args: unknown[]) => notifyBlocker(...args),
}));

const findPrsNeedingReview = vi.fn();
vi.mock('./external-review.js', () => ({
  findPrsNeedingReview: (...args: unknown[]) => findPrsNeedingReview(...args),
}));

const { processSlicePr, processIssue, agentTaskFor, discoverAssignedBugs, processExternalReviewCandidate, processTrustedFixCandidate, runExternalReviews, renderTrackingIssueBody } = await import('./tick.js');

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
    headRefName: 'ronin/228/slice-2',
    baseRefName: 'ronin/228/slice-1',
    isDraft: false,
    sliceIndex: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordSlicePr.mockResolvedValue(undefined);
  findUnprocessedMentions.mockResolvedValue([]);
  isFixCommentsCommand.mockReturnValue(false);
  listExternalOpenReviewThreads.mockResolvedValue([]);
  worktreeDirFor.mockReturnValue('/tmp/worktree');
  incrementAttemptCount.mockResolvedValue(1);
  existsSync.mockReturnValue(true);
  hasRemainingSlices.mockResolvedValue(true); // preserves pre-existing merge test behavior by default
  listAssignedBugIssues.mockResolvedValue([]);
  setLastReviewedSha.mockResolvedValue(undefined);
  activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' });
  readFile.mockResolvedValue('body\n{{spec_links}}\n');
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
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      checksPending: false,
      reviewDecision: 'APPROVED',
    });
    isBehind.mockResolvedValue(false);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledWith(229);
    expect(markSliceMerged).toHaveBeenCalledWith(228, 0);
    expect(removeWorktree).toHaveBeenCalledWith('ronin/228/slice-1');
  });

  it("uses the active repo's own worktreeBaseRef override, not config's, to decide the bottom PR is up to date", async () => {
    activeRepo.mockReturnValue({
      productRepo: 'bmedical/bmedical',
      productRepoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      worktreeBaseRef: 'origin/odoo-main',
    });
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'odoo-main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      checksPending: false,
      reviewDecision: 'APPROVED',
    });
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(isBehind).toHaveBeenCalledWith('/tmp/worktree-bottom', 'origin/odoo-main');
    expect(mergePullRequest).toHaveBeenCalledWith(229);
  });

  it('escalates once checksPendingRetryLimit is exceeded when checks never report', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPending: true,
    });
    isBehind.mockResolvedValue(false);
    incrementChecksPendingCount.mockResolvedValue(61); // > checksPendingRetryLimit (60)

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(false);
    expect(notifyBlocker).toHaveBeenCalled();
    expect(incrementChecksPendingCount).toHaveBeenCalledWith(229);
    expect(incrementAttemptCount).not.toHaveBeenCalled(); // not a GitHub label swap
  });

  // Regression: previously this shared the same counter/limit as
  // e2eRetryLimit (2), so a still-running CI got escalated after just 2
  // ticks — see PR #239, whose Integration Tests run alone took longer than
  // that. checksPendingRetryLimit (60) gives CI a real chance to report.
  it('does not escalate a still-running CI well within checksPendingRetryLimit', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPending: true,
    });
    isBehind.mockResolvedValue(false);
    incrementChecksPendingCount.mockResolvedValue(3); // well under checksPendingRetryLimit (60)

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(notifyBlocker).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-e2e' }));
  });

  it('resets the checks-pending counter once checks conclude, pass or fail', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: false,
      checksPending: false,
    });
    isBehind.mockResolvedValue(false);
    incrementAttemptCount.mockResolvedValue(1);

    await processSlicePr(issue(), bottomPr, true);

    expect(resetChecksPendingCount).toHaveBeenCalledWith(229);
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
      headRefName: 'ronin/228/slice-1',
      checksPassing: false, // stale snapshot taken before the mention landed
      reviewDecision: '',
    });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue({ ...bottomPr, checksPassing: true, reviewDecision: 'APPROVED' });
    isBehind.mockResolvedValue(false);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'review-request', issueNumber: 228, prNumber: 229,
      mentions: [{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }],
    });
    expect(stillInProgress).toBe(true);
    expect(mergePullRequest).toHaveBeenCalledWith(229);
  });

  it('posts a ronin/review commit status: pending before the agent run, success after', async () => {
    const bottomPr = pr({ number: 229, sliceIndex: 0, baseRefName: 'main', headRefName: 'ronin/228/slice-1', reviewDecision: '' });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue({ ...bottomPr, checksPassing: true, reviewDecision: 'APPROVED' });
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(setReviewStatus).toHaveBeenCalledWith(229, 'pending', expect.any(String));
    expect(setReviewStatus).toHaveBeenCalledWith(229, 'success', expect.any(String));
  });

  it('posts a ronin/review error status when the review agent throws', async () => {
    const bottomPr = pr({ number: 229, sliceIndex: 0, baseRefName: 'main', headRefName: 'ronin/228/slice-1', reviewDecision: '' });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }]);
    runAgentTask.mockRejectedValueOnce(new Error('claude -p timeout'));

    await processSlicePr(issue(), bottomPr, true);

    expect(setReviewStatus).toHaveBeenCalledWith(229, 'error', expect.any(String));
  });

});

describe('processSlicePr — /fix-comments command', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  function bottomPrReadyToMerge(overrides: Partial<StackedPr> = {}): StackedPr {
    return pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      reviewDecision: 'APPROVED',
      ...overrides,
    });
  }

  it('runs fix-comments with the fetched external threads, and reacts to the command comment', async () => {
    const commandComment = { id: 1, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    listExternalOpenReviewThreads.mockResolvedValue([{ id: 'T1', body: 'finding from Copilot' }]);
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(listExternalOpenReviewThreads).toHaveBeenCalledWith(229, undefined);
    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'fix-comments', issueNumber: 228, prNumber: 229,
      trigger: [commandComment], openThreads: [{ id: 'T1', body: 'finding from Copilot' }],
    });
    expect(addReaction).toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('does not route a command comment through review-request', async () => {
    const commandComment = { id: 1, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'review-request' }));
  });

  it('splits a plain mention and a command mention into review-request and fix-comments respectively', async () => {
    const plainMention = { id: 1, kind: 'issue' as const, body: '@ronin fijate esto', reactionsEyes: 0 };
    const commandComment = { id: 2, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([plainMention, commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'review-request', issueNumber: 228, prNumber: 229, mentions: [plainMention],
    });
    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'fix-comments', issueNumber: 228, prNumber: 229, trigger: [commandComment], openThreads: [],
    });
    expect(addReaction).toHaveBeenCalledWith(1, 'issue', 'eyes');
    expect(addReaction).toHaveBeenCalledWith(2, 'issue', 'eyes');
  });

  it('does not react to the command comment when the fix-comments task throws, so the next tick retries it', async () => {
    const commandComment = { id: 1, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    runAgentTask.mockImplementation(async (task) => {
      if (task.type === 'fix-comments') throw new Error('boom');
    });
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(addReaction).not.toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('does not fetch external threads or run fix-comments when there is no command mention', async () => {
    findUnprocessedMentions.mockResolvedValue([]);
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(listExternalOpenReviewThreads).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-comments' }));
  });
});

describe('processIssue — starting a next slice while the stack is still open', () => {
  function openBottomPr(): StackedPr {
    return pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      checksPending: false,
      reviewDecision: '', // not yet approved, so it stays open — stack.length stays 1
    });
  }

  beforeEach(() => {
    isBehind.mockResolvedValue(false);
    nextUnstartedSlice.mockResolvedValue({ index: 1, title: 'Slice 2', checked: false, prNumber: null });
  });

  it('does not start the next slice when the issue lacks ronin:stack-prs', async () => {
    const result = await processIssue(issue({ labels: [] }), [openBottomPr()]);

    expect(result).toBeNull();
    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'implement-slice' }));
  });

  it('starts the next slice, stacked, when the issue carries ronin:stack-prs', async () => {
    const result = await processIssue(issue({ labels: ['ronin:stack-prs'] }), [openBottomPr()]);

    expect(result).toEqual({ issue: issue({ labels: ['ronin:stack-prs'] }), index: 1, title: 'Slice 2', stackSize: 1 });
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
      headRefName: 'ronin/228/slice-1',
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
      headRefName: 'ronin/228/slice-1',
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
  it('labels, seeds, and starts a bug issue not yet ronin-managed', async () => {
    listAssignedBugIssues.mockResolvedValue([{ number: 500, title: 'Login redirects to 404' }]);

    await discoverAssignedBugs();

    expect(addIssueLabel).toHaveBeenCalledWith(500, 'ronin');
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

  // Regression: this function runs directly in tick(), outside runIssueStep's
  // safety net, so a failure processing one bug issue must not escape and
  // abort the whole tick — it must escalate that one issue and move on.
  it('escalates instead of throwing when processing a bug issue fails', async () => {
    listAssignedBugIssues.mockResolvedValue([{ number: 501, title: 'Crashes on load' }]);
    addIssueLabel.mockRejectedValueOnce(new Error('gh: HTTP 500'));
    setIssueState.mockResolvedValue(undefined);

    await expect(discoverAssignedBugs()).resolves.toBeUndefined();

    expect(notifyBlocker).toHaveBeenCalled();
    expect(setIssueState).toHaveBeenCalledWith(501, 'blocked');
  });
});

describe('processExternalReviewCandidate', () => {
  const candidate = { prNumber: 305, headRefName: 'someone-else/feature-x', headSha: 'abc123', openThreads: [], mentions: [] };

  it('runs the external-review agent task and records the reviewed SHA on success', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processExternalReviewCandidate(candidate);

    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'external-review',
      prNumber: 305,
      headRefName: 'someone-else/feature-x',
      headSha: 'abc123',
      openThreads: [],
      mentions: [],
    });
    expect(setLastReviewedSha).toHaveBeenCalledWith(305, 'abc123');
  });

  it('does not record the SHA when the agent task throws', async () => {
    runAgentTask.mockRejectedValue(new Error('claude -p timed out'));

    await expect(processExternalReviewCandidate(candidate)).resolves.toBeUndefined();

    expect(setLastReviewedSha).not.toHaveBeenCalled();
  });

  it('swallows the error instead of propagating it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await expect(processExternalReviewCandidate(candidate)).resolves.not.toThrow();
  });

  it('reacts with eyes on each mention that triggered the run, after a successful run', async () => {
    runAgentTask.mockResolvedValue(undefined);
    const withMentions = {
      ...candidate,
      mentions: [{ id: 7, kind: 'issue' as const, body: '@ronin-agent revisá', reactionsEyes: 0, authorLogin: 'someone' }],
    };

    await processExternalReviewCandidate(withMentions);

    expect(addReaction).toHaveBeenCalledWith(7, 'issue', 'eyes');
  });

  it('does not react to mentions when the agent task throws, so the next tick retries them', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));
    const withMentions = {
      ...candidate,
      mentions: [{ id: 7, kind: 'issue' as const, body: '@ronin-agent revisá', reactionsEyes: 0, authorLogin: 'someone' }],
    };

    await processExternalReviewCandidate(withMentions);

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('does not react at all when there were no mentions', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processExternalReviewCandidate(candidate);

    expect(addReaction).not.toHaveBeenCalled();
  });
});

describe('processTrustedFixCandidate', () => {
  const candidate = {
    prNumber: 599,
    headRefName: 'feat/cambio-cliente',
    trigger: [{ id: 9, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0, authorLogin: 'someone' }],
    openThreads: [{ id: 'T5', body: 'BranchId reasignado incondicionalmente' }],
  };

  it('runs the fix-comments-external agent task', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processTrustedFixCandidate(candidate);

    expect(runAgentTask).toHaveBeenCalledWith({
      type: 'fix-comments-external',
      prNumber: 599,
      headRefName: 'feat/cambio-cliente',
      trigger: candidate.trigger,
      openThreads: candidate.openThreads,
    });
  });

  it('reacts with eyes on the trigger comment(s), after a successful run', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processTrustedFixCandidate(candidate);

    expect(addReaction).toHaveBeenCalledWith(9, 'issue', 'eyes');
  });

  it('does not react when the agent task throws, so the next tick retries it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await processTrustedFixCandidate(candidate);

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('swallows the error instead of propagating it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await expect(processTrustedFixCandidate(candidate)).resolves.not.toThrow();
  });
});

describe('renderTrackingIssueBody', () => {
  it('links spec files against the global default branch when the active repo has no override', async () => {
    const body = await renderTrackingIssueBody(['docs/superpowers/specs/foo.md']);

    expect(body).toContain('https://github.com/bmedical/bmedical/blob/main/docs/superpowers/specs/foo.md');
  });

  it("links spec files against the active repo's own worktreeBaseRef override, not the global default", async () => {
    activeRepo.mockReturnValue({
      productRepo: 'redmotos/shoppingcart',
      productRepoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
      worktreeBaseRef: 'origin/odoo-main',
    });

    const body = await renderTrackingIssueBody(['docs/superpowers/specs/foo.md']);

    expect(body).toContain('https://github.com/redmotos/shoppingcart/blob/odoo-main/docs/superpowers/specs/foo.md');
  });
});

// Wiring coverage for the extraction in final review Fix 4: external review
// used to live inline in tickOneRepo, after an early `return` on an
// unrelated listAllOpenRoninPrs failure — untestable on its own, and
// silently skipped for a whole tick whenever that unrelated call flaked.
describe('runExternalReviews', () => {
  beforeEach(() => {
    runAgentTask.mockResolvedValue(undefined);
  });

  it('runs one agent task per read-only candidate findPrsNeedingReview returns', async () => {
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [
        { prNumber: 305, headRefName: 'someone-else/feature-x', headSha: 'abc123', openThreads: [], mentions: [] },
        { prNumber: 306, headRefName: 'other/feature-y', headSha: 'def456', openThreads: [], mentions: [] },
      ],
      trustedFixCandidates: [],
    });

    await runExternalReviews();

    expect(runAgentTask).toHaveBeenCalledTimes(2);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'external-review', prNumber: 305, headSha: 'abc123' }));
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'external-review', prNumber: 306, headSha: 'def456' }));
    // Commit status keyed to the candidate's known head SHA, no extra `gh pr view`.
    expect(setReviewStatus).toHaveBeenCalledWith(305, 'pending', expect.any(String), { sha: 'abc123' });
    expect(setReviewStatus).toHaveBeenCalledWith(305, 'success', expect.any(String), { sha: 'abc123' });
  });

  it('runs one fix-comments-external agent task per trusted-fix candidate', async () => {
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [],
      trustedFixCandidates: [
        { prNumber: 599, headRefName: 'feat/cambio-cliente', trigger: [{ id: 9, kind: 'issue' as const, body: '/fix-comments', reactionsEyes: 0, authorLogin: 'someone' }], openThreads: [] },
      ],
    });

    await runExternalReviews();

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-comments-external', prNumber: 599, headRefName: 'feat/cambio-cliente' }));
  });

  it('does not throw, and runs nothing, when discovery itself fails', async () => {
    findPrsNeedingReview.mockRejectedValue(new Error('gh exploded'));

    await expect(runExternalReviews()).resolves.toBeUndefined();

    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('does nothing when there are no candidates of either kind', async () => {
    findPrsNeedingReview.mockResolvedValue({ reviewCandidates: [], trustedFixCandidates: [] });

    await runExternalReviews();

    expect(runAgentTask).not.toHaveBeenCalled();
  });
});
