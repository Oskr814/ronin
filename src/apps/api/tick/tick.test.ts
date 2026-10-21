import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackingIssue } from '@platform/github/github.js';
import type { StackedPr } from '@domains/slices/stack.js';
import { HELP_FOOTER_MARKER } from '@domains/commands/help.js';

const existsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
}));

const readFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFile(...args),
}));

vi.mock('@platform/config/config.js', () => ({
  config: {
    e2eRetryLimit: 2,
    e2eAttemptHardLimit: 5,
    checksPendingRetryLimit: 60,
    sliceAttemptLimit: 3,
    retargetRetryLimit: 3,
    worktreeBaseRef: 'origin/main',
    githubLogin: 'ronin',
    // Needed by runJobs — with an undefined limit the pool starts nothing
    // and silently no-ops.
    tickConcurrency: 3,
    externalReviewConcurrency: 1,
  },
  concurrencyFor: () => 3,
  LABEL_DIRECT_ISSUE: 'ronin:issue-fix',
  LABEL_MANAGED: 'ronin',
  LABEL_STACK_PRS: 'ronin:stack-prs',
  LABEL_STATES: { ready: 'ronin:ready', 'in-progress': 'ronin:in-progress', blocked: 'ronin:blocked', done: 'ronin:done' },
}));

vi.mock('@platform/locks/locks.js', () => ({
  issueResource: (n: number) => `issue-${n}`,
  prResource: (n: number) => `pr-${n}`,
  tryLockResource: async () => true,
  unlockResource: async () => {},
  withResourceLock: async (_r: string, _m: string, fn: () => Promise<void>) => { await fn(); return true; },
  withSlots: (_k: string, _l: number, _c: unknown, fn: () => Promise<unknown>) => fn(),
  pinResources: async () => {},
  unpinResources: async () => {},
}));

const activeRepo = vi.fn();
const linearKey = vi.fn();
const currentCycle = vi.fn();
vi.mock('@platform/linear/linear-api.js', () => ({
  linearKey: (...args: unknown[]) => linearKey(...args),
  currentCycle: (...args: unknown[]) => currentCycle(...args),
}));

vi.mock('@platform/agents/repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

const recordSlicePr = vi.fn();
const markSliceMerged = vi.fn();
const hasRemainingSlices = vi.fn();
const seedSingleSlice = vi.fn();
const nextUnstartedSlice = vi.fn();
const getSlices = vi.fn();
vi.mock('@domains/slices/checklist.js', () => ({
  recordSlicePr: (...args: unknown[]) => recordSlicePr(...args),
  markSliceMerged: (...args: unknown[]) => markSliceMerged(...args),
  hasRemainingSlices: (...args: unknown[]) => hasRemainingSlices(...args),
  seedSingleSlice: (...args: unknown[]) => seedSingleSlice(...args),
  nextUnstartedSlice: (...args: unknown[]) => nextUnstartedSlice(...args),
  getSlices: (...args: unknown[]) => getSlices(...args),
}));

const addReaction = vi.fn();
const retargetDependents = vi.fn();
const incrementAttemptCount = vi.fn();
const setIssueState = vi.fn();
const getPullRequestStatus = vi.fn();
const addIssueLabel = vi.fn();
const listAssignedIssues = vi.fn();
const listExternalOpenReviewThreads = vi.fn();
const setReviewStatus = vi.fn();
const setPullRequestBody = vi.fn();
const listIssueComments = vi.fn();
const resetAttemptCount = vi.fn();
const isTransientGhError = vi.fn();
const getFailedChecks = vi.fn();
const listTrackingIssues = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  listTrackingIssues: (...args: unknown[]) => listTrackingIssues(...args),
  attemptCountFromLabels: (labels: string[]) => Number(labels.map((l) => l.match(/^ronin:attempts-(\d+)$/)?.[1]).find(Boolean) ?? 0),
  resetAttemptCount: (...args: unknown[]) => resetAttemptCount(...args),
  isTransientGhError: (...args: unknown[]) => isTransientGhError(...args),
  getIssueLabels: async () => ['ronin', 'ronin:in-progress'],
  addReaction: (...args: unknown[]) => addReaction(...args),
  retargetDependents: (...args: unknown[]) => retargetDependents(...args),
  incrementAttemptCount: (...args: unknown[]) => incrementAttemptCount(...args),
  setIssueState: (...args: unknown[]) => setIssueState(...args),
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
  addIssueLabel: (...args: unknown[]) => addIssueLabel(...args),
  listAssignedIssues: (...args: unknown[]) => listAssignedIssues(...args),
  listExternalOpenReviewThreads: (...args: unknown[]) => listExternalOpenReviewThreads(...args),
  setReviewStatus: (...args: unknown[]) => setReviewStatus(...args),
  setPullRequestBody: (...args: unknown[]) => setPullRequestBody(...args),
  listIssueComments: (...args: unknown[]) => listIssueComments(...args),
  changesRequestedOnHead: (...args: unknown[]) => changesRequestedOnHead(...args),
  getFailedChecks: (...args: unknown[]) => getFailedChecks(...args),
}));

// Done-ness lives in the local state now (processed-comments.ts, tested on
// its own); here it's still read off the 👀, as these tests set it up.
vi.mock('@platform/state/processed-comments.js', () => ({
  markProcessed: (c: { id: number; kind: string }) => addReaction(c.id, c.kind, 'eyes'),
}));

const incrementChecksPendingCount = vi.fn();
const resetChecksPendingCount = vi.fn();
const setLastReviewedSha = vi.fn();
const setLastChangelogRelease = vi.fn();
const recordFailureSignature = vi.fn();
vi.mock('@platform/state/local-state.js', () => ({
  incrementChecksPendingCount: (...args: unknown[]) => incrementChecksPendingCount(...args),
  resetChecksPendingCount: (...args: unknown[]) => resetChecksPendingCount(...args),
  setLastReviewedSha: (...args: unknown[]) => setLastReviewedSha(...args),
  setLastChangelogRelease: (...args: unknown[]) => setLastChangelogRelease(...args),
  recordFailureSignature: (...args: unknown[]) => recordFailureSignature(...args),
  pruneFailureSignatures: vi.fn(),
}));

const worktreeDirFor = vi.fn();
const removeWorktree = vi.fn();
vi.mock('@platform/git/worktree.js', () => ({
  worktreeDirFor: (...args: unknown[]) => worktreeDirFor(...args),
  removeWorktree: (...args: unknown[]) => removeWorktree(...args),
}));

const findUnprocessedMentions = vi.fn();
const isFixCommentsCommand = vi.fn();
vi.mock('@domains/commands/mentions.js', () => ({
  findUnprocessedMentions: (...args: unknown[]) => findUnprocessedMentions(...args),
  isFixCommentsCommand: (...args: unknown[]) => isFixCommentsCommand(...args),
}));

const runExternalReview = vi.fn();
vi.mock('@domains/review/publish.js', () => ({ runExternalReview }));

const changesRequestedOnHead = vi.fn();
const runAgentTask = vi.fn();
vi.mock('@platform/agents/agent-task.js', () => ({
  runAgentTask: (...args: unknown[]) => runAgentTask(...args),
}));

const notifyBlocker = vi.fn();
vi.mock('@platform/notify/notifier.js', () => ({
  notifyBlocker: (...args: unknown[]) => notifyBlocker(...args),
}));

const findPrsNeedingReview = vi.fn();
vi.mock('@domains/review/external.js', () => ({
  findPrsNeedingReview: (...args: unknown[]) => findPrsNeedingReview(...args),
}));

const findIssuesNeedingSpike = vi.fn();
vi.mock('@domains/commands/spike.js', () => ({
  findIssuesNeedingSpike: (...args: unknown[]) => findIssuesNeedingSpike(...args),
}));

const findReleasesNeedingChangelog = vi.fn();
vi.mock('@domains/changelog/changelog.js', () => ({
  findReleasesNeedingChangelog: (...args: unknown[]) => findReleasesNeedingChangelog(...args),
}));

const { runScoped, runIssueStep, idleCommandJobs, specRevisionJobs, processSlicePr, processIssue, finishClosedIssues, agentTaskFor, needsMoreInfo, discoverAssignedIssues, processExternalReviewCandidate, processTrustedFixCandidate, runExternalReviews, processSpikeCandidate, processChangelogCandidate, runChangelogUpdates, renderTrackingIssueBody, cycleFirst } = await import('./tick.js');

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
    // Already carries the cheat sheet, so tests about anything else don't
    // also exercise the footer write — see the 'command cheat sheet' tests.
    body: `Slice description\n\n${HELP_FOOTER_MARKER}`,
    sliceIndex: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordSlicePr.mockResolvedValue(undefined);
  setPullRequestBody.mockResolvedValue(undefined);
  listIssueComments.mockResolvedValue([]);
  findUnprocessedMentions.mockResolvedValue([]);
  isFixCommentsCommand.mockReturnValue(false);
  listExternalOpenReviewThreads.mockResolvedValue([]);
  worktreeDirFor.mockReturnValue('/tmp/worktree');
  incrementAttemptCount.mockResolvedValue(1);
  getFailedChecks.mockResolvedValue([{ name: 'CI', log: '##[error]boom' }]);
  recordFailureSignature.mockResolvedValue(1);
  changesRequestedOnHead.mockResolvedValue(true);
  existsSync.mockReturnValue(true);
  getSlices.mockResolvedValue([]);
  hasRemainingSlices.mockResolvedValue(true); // preserves pre-existing merge test behavior by default
  listAssignedIssues.mockResolvedValue([]);
  setLastReviewedSha.mockResolvedValue(undefined);
  removeWorktree.mockResolvedValue(undefined);
  activeRepo.mockReturnValue({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' });
  readFile.mockResolvedValue('body\n{{spec_links}}\n');
});

describe('cycleFirst', () => {
  const issues = [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 }), issue({ number: 4 })];

  it("puts the current cycle's issues first, each group in its order", async () => {
    linearKey.mockReturnValue('lin_api_x');
    currentCycle.mockResolvedValue({ number: 17, issues: [{ githubNumber: 4 }, { githubNumber: 2 }, { id: 'RED-9' }] });
    expect((await cycleFirst(issues)).map((i) => i.number)).toEqual([2, 4, 1, 3]);
  });

  it('keeps the order without a Linear key, or when Linear fails', async () => {
    linearKey.mockReturnValue(null);
    expect(await cycleFirst(issues)).toBe(issues);
    expect(currentCycle).not.toHaveBeenCalled();

    linearKey.mockReturnValue('lin_api_x');
    currentCycle.mockRejectedValue(new Error('Linear respondió 500'));
    expect((await cycleFirst(issues)).map((i) => i.number)).toEqual([1, 2, 3, 4]);
  });
});

describe('processSlicePr — Linear link', () => {
  const linkback = {
    authorLogin: 'linear-code[bot]',
    body: '<!-- linear-linkback -->\n<p><a href="https://linear.app/red-motos/issue/RED-214/extraer-un-componente">RED-214</a></p>',
  };
  const twoSlices = [
    { index: 0, title: 'Slice 1', checked: true, prNumber: 229 },
    { index: 1, title: 'Slice 2', checked: false, prNumber: 230 },
  ];

  it('links an intermediate slice with "Part of", above the cheat sheet', async () => {
    listIssueComments.mockResolvedValue([linkback]);
    getSlices.mockResolvedValue([...twoSlices, { index: 2, title: 'Slice 3', checked: false, prNumber: null }]);

    await processSlicePr(issue(), pr({ checksPending: true }), false);

    expect(listIssueComments).toHaveBeenCalledWith(228);
    expect(setPullRequestBody).toHaveBeenCalledWith(230, `Slice description\n\n<!-- ronin:linear -->\nPart of RED-214\n\n${HELP_FOOTER_MARKER}`);
  });

  it('links the last slice with "Fixes"', async () => {
    listIssueComments.mockResolvedValue([linkback]);
    getSlices.mockResolvedValue(twoSlices);

    await processSlicePr(issue(), pr({ checksPending: true }), false);

    expect(setPullRequestBody.mock.calls[0][1]).toContain('<!-- ronin:linear -->\nFixes RED-214');
  });

  it('reads the identifier from a PR already linked, without reading the issue', async () => {
    getSlices.mockResolvedValue(twoSlices);

    await processSlicePr(issue(), pr({ checksPending: true, body: `Slice\n\n<!-- ronin:linear -->\nFixes RED-214\n\n${HELP_FOOTER_MARKER}` }), false);

    expect(listIssueComments).not.toHaveBeenCalled();
    expect(setPullRequestBody).not.toHaveBeenCalled();
  });

  it('leaves the body alone when the issue has no Linear issue', async () => {
    listIssueComments.mockResolvedValue([{ authorLogin: 'oskr814', body: '<!-- linear-linkback -->\n<a href="https://linear.app/x/issue/RED-1">RED-1</a>' }]);

    await processSlicePr(issue(), pr({ checksPending: true }), false);

    expect(setPullRequestBody).not.toHaveBeenCalled();
  });

  it('still adds the cheat sheet when reading the issue fails', async () => {
    listIssueComments.mockRejectedValue(new Error('gh exploded'));

    await processSlicePr(issue(), pr({ body: 'Slice description', checksPending: true }), false);

    expect(setPullRequestBody.mock.calls[0][1]).not.toContain('ronin:linear');
    expect(setPullRequestBody.mock.calls[0][1]).toContain(HELP_FOOTER_MARKER);
  });
});

describe('processSlicePr — command cheat sheet', () => {
  it('appends the cheat sheet to a PR body that does not have it yet', async () => {
    await processSlicePr(issue(), pr({ body: 'Slice description', checksPending: true }), false);

    expect(setPullRequestBody).toHaveBeenCalledTimes(1);
    const [prNumber, body] = setPullRequestBody.mock.calls[0];
    expect(prNumber).toBe(230);
    expect(body).toMatch(/^Slice description\n\n/);
    expect(body).toContain(HELP_FOOTER_MARKER);
  });

  it('leaves a PR body that already has the cheat sheet untouched', async () => {
    await processSlicePr(issue(), pr({ checksPending: true }), false);

    expect(setPullRequestBody).not.toHaveBeenCalled();
  });

  it('keeps processing the slice when the body edit fails', async () => {
    setPullRequestBody.mockRejectedValue(new Error('gh exploded'));

    const stillInProgress = await processSlicePr(
      issue(),
      pr({ body: 'Slice description', checksPending: true, reviewDecision: 'CHANGES_REQUESTED' }),
      false,
    );

    expect(stillInProgress).toBe(true);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-review', issueNumber: 228, prNumber: 230 }));
  });
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
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-review', issueNumber: 228, prNumber: 230 }));
  });
});

describe('processSlicePr — changes requested on an older commit', () => {
  it('waits for a re-review instead of running fix-review or counting an attempt', async () => {
    changesRequestedOnHead.mockResolvedValue(false);

    const stillInProgress = await processSlicePr(issue(), pr({ reviewDecision: 'CHANGES_REQUESTED' }), false);

    expect(stillInProgress).toBe(true);
    expect(changesRequestedOnHead).toHaveBeenCalledWith(230);
    expect(incrementAttemptCount).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalled();
    expect(notifyBlocker).not.toHaveBeenCalled();
  });
});

describe('processSlicePr — bottom-of-stack PR (unchanged behavior)', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  it('never merges an approved, green PR: waits for a human to merge it', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      checksPending: false,
      reviewDecision: 'APPROVED',
    });

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(markSliceMerged).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(setIssueState).not.toHaveBeenCalled();
  });

  it('waits without rebasing when the bottom PR is approved and green, even if main moved', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPassing: true,
      reviewDecision: 'APPROVED',
    });

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(incrementAttemptCount).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it("waits for the retarget when the bottom PR's base is not the root branch", async () => {
    const bottomPr = pr({ number: 229, sliceIndex: 0, baseRefName: 'ronin/228/slice-0', headRefName: 'ronin/228/slice-1' });
    incrementAttemptCount.mockResolvedValue(1);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(true);
    expect(incrementAttemptCount).toHaveBeenCalledWith(229);
    expect(setIssueState).not.toHaveBeenCalled();
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('blocks the issue once the bottom PR has sat on the wrong base past retargetRetryLimit', async () => {
    const bottomPr = pr({ number: 229, sliceIndex: 0, baseRefName: 'ronin/228/slice-0', headRefName: 'ronin/228/slice-1' });
    incrementAttemptCount.mockResolvedValue(4);

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(stillInProgress).toBe(false);
    expect(setIssueState).toHaveBeenCalledWith(228, 'blocked');
  });

  it("uses the active repo's own worktreeBaseRef override, not config's, as the bottom PR's expected base", async () => {
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

    await processSlicePr(issue(), bottomPr, true);

    expect(incrementAttemptCount).not.toHaveBeenCalled();
  });

  it('escalates once checksPendingRetryLimit is exceeded when checks never report', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'ronin/228/slice-1',
      checksPending: true,
    });
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
    incrementAttemptCount.mockResolvedValue(1);

    await processSlicePr(issue(), bottomPr, true);

    expect(resetChecksPendingCount).toHaveBeenCalledWith(229);
  });
});

describe('processSlicePr — failing checks, by failure signature', () => {
  const failingBottom = () => pr({ number: 229, sliceIndex: 0, baseRefName: 'main', headRefName: 'ronin/228/slice-1' });

  it('runs fix-e2e while a failure has not repeated past the limit', async () => {
    recordFailureSignature.mockResolvedValue(2);

    const stillInProgress = await processSlicePr(issue(), failingBottom(), true);

    expect(stillInProgress).toBe(true);
    expect(getFailedChecks).toHaveBeenCalledWith(229);
    expect(recordFailureSignature).toHaveBeenCalledWith(229, expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 }));
    expect(notifyBlocker).not.toHaveBeenCalled();
  });

  it('blocks when the same failure comes back past the limit, naming what keeps failing', async () => {
    getFailedChecks.mockResolvedValue([{ name: 'CI', log: ' FAIL  src/a.spec.ts > guarda el pedido' }]);
    recordFailureSignature.mockResolvedValue(3);

    const stillInProgress = await processSlicePr(issue(), failingBottom(), true);

    expect(stillInProgress).toBe(false);
    expect(setIssueState).toHaveBeenCalledWith(228, 'blocked');
    expect(runAgentTask).not.toHaveBeenCalled();
    const blocker = notifyBlocker.mock.calls[0][0];
    expect(blocker.reason).toMatch(/misma falla/);
    expect(blocker.excerpt).toContain('fail src/a.spec.ts > guarda el pedido');
  });

  it('keeps going past E2E_RETRY_LIMIT attempts while each one fails differently', async () => {
    incrementAttemptCount.mockResolvedValue(4);
    recordFailureSignature.mockResolvedValue(1);

    const stillInProgress = await processSlicePr(issue(), failingBottom(), true);

    expect(stillInProgress).toBe(true);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 }));
  });

  it('blocks at the hard limit even when every failure is new', async () => {
    incrementAttemptCount.mockResolvedValue(6);
    recordFailureSignature.mockResolvedValue(1);

    const stillInProgress = await processSlicePr(issue(), failingBottom(), true);

    expect(stillInProgress).toBe(false);
    expect(notifyBlocker.mock.calls[0][0].reason).toMatch(/sin converger/);
    expect(setIssueState).toHaveBeenCalledWith(228, 'blocked');
  });

  it('falls back to counting attempts against E2E_RETRY_LIMIT when the checks cannot be read', async () => {
    getFailedChecks.mockRejectedValue(new Error('HTTP 502'));
    incrementAttemptCount.mockResolvedValue(3);

    const stillInProgress = await processSlicePr(issue(), failingBottom(), true);

    expect(stillInProgress).toBe(false);
    expect(recordFailureSignature).not.toHaveBeenCalled();
    expect(notifyBlocker.mock.calls[0][0].reason).toBe('E2E fallando persistentemente tras el límite de reintentos');
  });
});

describe('processSlicePr — mentions found on an already-mergeable bottom PR (regression)', () => {
  beforeEach(() => {
    worktreeDirFor.mockReturnValue('/tmp/worktree-bottom');
  });

  it('re-reads fresh PR state after review-request, instead of acting on the stale snapshot', async () => {
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

    const stillInProgress = await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'review-request', issueNumber: 228, prNumber: 229,
      mentions: [{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }],
    }));
    expect(stillInProgress).toBe(true);
    expect(getPullRequestStatus).toHaveBeenCalledWith(229);
  });

  it('posts a ronin/review commit status: pending before the agent run, success after', async () => {
    const bottomPr = pr({ number: 229, sliceIndex: 0, baseRefName: 'main', headRefName: 'ronin/228/slice-1', reviewDecision: '' });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue({ ...bottomPr, checksPassing: true, reviewDecision: 'APPROVED' });

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

    await processSlicePr(issue(), bottomPr, true);

    expect(listExternalOpenReviewThreads).toHaveBeenCalledWith(229, 'ronin');
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fix-comments', issueNumber: 228, prNumber: 229,
      trigger: [commandComment], openThreads: [{ id: 'T1', body: 'finding from Copilot' }],
    }));
    expect(addReaction).toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('does not route a command comment through review-request', async () => {
    const commandComment = { id: 1, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);

    await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'review-request' }));
  });

  it('routes an inline review-comment /fix-comments command through fix-comments, not review-request', async () => {
    const commandComment = { id: 5, kind: 'review' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    listExternalOpenReviewThreads.mockResolvedValue([]);
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);

    await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fix-comments', issueNumber: 228, prNumber: 229,
      trigger: [commandComment], openThreads: [],
    }));
    expect(runAgentTask).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'review-request' }));
    expect(addReaction).toHaveBeenCalledWith(5, 'review', 'eyes');
  });

  it('splits a plain mention and a command mention into review-request and fix-comments respectively', async () => {
    const plainMention = { id: 1, kind: 'issue' as const, body: '@ronin fijate esto', reactionsEyes: 0 };
    const commandComment = { id: 2, kind: 'issue' as const, body: '@ronin /fix-comments', reactionsEyes: 0 };
    findUnprocessedMentions.mockResolvedValue([plainMention, commandComment]);
    isFixCommentsCommand.mockImplementation((body: string) => body.includes('/fix-comments'));
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);

    await processSlicePr(issue(), bottomPr, true);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'review-request', issueNumber: 228, prNumber: 229, mentions: [plainMention],
    }));
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fix-comments', issueNumber: 228, prNumber: 229, trigger: [commandComment], openThreads: [],
    }));
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

    await processSlicePr(issue(), bottomPr, true);

    expect(addReaction).not.toHaveBeenCalledWith(1, 'issue', 'eyes');
  });

  it('does not fetch external threads or run fix-comments when there is no command mention', async () => {
    findUnprocessedMentions.mockResolvedValue([]);
    const bottomPr = bottomPrReadyToMerge();
    getPullRequestStatus.mockResolvedValue(bottomPr);

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

describe('finishClosedIssues — closed issues still labeled in-progress', () => {
  const slice = (index: number, checked: boolean, prNumber: number | null) => ({ index, title: `Slice ${index + 1}`, checked, prNumber });

  beforeEach(() => {
    listTrackingIssues.mockResolvedValue([issue()]);
  });

  it('marks done one whose slices all merged', async () => {
    getSlices.mockResolvedValue([slice(0, true, 229)]);
    await finishClosedIssues([]);
    expect(setIssueState).toHaveBeenCalledWith(228, 'done');
  });

  it('marks done one closed by hand with a slice never merged and no PR open', async () => {
    getSlices.mockResolvedValue([slice(0, true, 229), slice(1, false, 230), slice(2, false, null)]);
    getPullRequestStatus.mockResolvedValue(pr({ number: 230, state: 'CLOSED' }));
    await finishClosedIssues([]);
    expect(setIssueState).toHaveBeenCalledWith(228, 'done');
  });

  it('waits while a pending slice still has its PR open', async () => {
    getSlices.mockResolvedValue([slice(0, false, 229)]);
    await finishClosedIssues([pr({ number: 229 })]);
    expect(setIssueState).not.toHaveBeenCalled();
    expect(getPullRequestStatus).not.toHaveBeenCalled();
  });
});

describe('agentTaskFor', () => {
  it('routes to implement-slice for a spec tracking issue without the direct-issue label', () => {
    expect(agentTaskFor(issue({ labels: [] }), 2, 'Tabla de citas')).toEqual(expect.objectContaining({
      type: 'implement-slice', issueNumber: 228, sliceIndex: 2, sliceTitle: 'Tabla de citas',
    }));
  });

  it('routes to fix-issue for an issue labeled ronin:issue-fix', () => {
    expect(agentTaskFor(issue({ labels: ['ronin:issue-fix'] }), 0, 'Fix — Login redirects to 404')).toEqual(expect.objectContaining({
      type: 'fix-issue', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix — Login redirects to 404',
    }));
  });
});

describe('needsMoreInfo', () => {
  it('is true when the agent ends its response with RONIN_STATUS: needs-info', () => {
    expect(needsMoreInfo('Some notes.\nRONIN_STATUS: needs-info')).toBe(true);
  });

  it('is false when the agent ends its response with RONIN_STATUS: done', () => {
    expect(needsMoreInfo('Opened PR #42.\nRONIN_STATUS: done')).toBe(false);
  });

  it('is false when the marker is missing entirely', () => {
    expect(needsMoreInfo('Opened PR #42.')).toBe(false);
  });
});

describe('processIssue — slices merged by a human', () => {
  const merged = { number: 229, state: 'MERGED', headRefName: 'ronin/228/slice-1', baseRefName: 'main' };

  it('checks off the merged slice, retargets what was stacked on it, and marks the issue done when it was the last', async () => {
    getSlices.mockResolvedValue([{ index: 0, title: 'Slice 1', checked: false, prNumber: 229 }]);
    getPullRequestStatus.mockResolvedValue(merged);
    nextUnstartedSlice.mockResolvedValue(null);
    hasRemainingSlices.mockResolvedValue(false);

    await processIssue(issue(), []);

    expect(markSliceMerged).toHaveBeenCalledWith(228, 0);
    expect(retargetDependents).toHaveBeenCalledWith('ronin/228/slice-1', 'main');
    expect(setIssueState).toHaveBeenCalledWith(228, 'done');
  });

  it('hands the next slice its new base in the same tick', async () => {
    getSlices.mockResolvedValue([
      { index: 0, title: 'Slice 1', checked: false, prNumber: 229 },
      { index: 1, title: 'Slice 2', checked: false, prNumber: 230 },
    ]);
    getPullRequestStatus.mockResolvedValue(merged);
    worktreeDirFor.mockReturnValue('/tmp/worktree');

    await processIssue(issue(), [pr({ number: 230, sliceIndex: 1, baseRefName: 'ronin/228/slice-1', headRefName: 'ronin/228/slice-2', checksPending: true })]);

    expect(markSliceMerged).toHaveBeenCalledWith(228, 0);
    expect(markSliceMerged).not.toHaveBeenCalledWith(228, 1);
    // The retargeted base already counts as the root branch: no attempt spent waiting on it.
    expect(incrementAttemptCount).not.toHaveBeenCalled();
  });

  it('leaves a slice whose PR was closed without merging for the empty-stack check to escalate', async () => {
    getSlices.mockResolvedValue([{ index: 0, title: 'Slice 1', checked: false, prNumber: 229 }]);
    getPullRequestStatus.mockResolvedValue({ ...merged, state: 'CLOSED' });
    nextUnstartedSlice.mockResolvedValue(null);
    hasRemainingSlices.mockResolvedValue(true);

    await processIssue(issue(), []);

    expect(markSliceMerged).not.toHaveBeenCalled();
    expect(notifyBlocker).toHaveBeenCalled();
    expect(setIssueState).toHaveBeenCalledWith(228, 'blocked');
  });
});

describe('discoverAssignedIssues', () => {
  it('labels, seeds, and starts an assigned issue not yet ronin-managed', async () => {
    listAssignedIssues.mockResolvedValue([{ number: 500, title: 'Login redirects to 404' }]);

    const started = await discoverAssignedIssues();

    expect(addIssueLabel).toHaveBeenCalledWith(500, 'ronin');
    expect(addIssueLabel).toHaveBeenCalledWith(500, 'ronin:issue-fix');
    expect(seedSingleSlice).toHaveBeenCalledWith(500, 'Fix — Login redirects to 404');
    expect(setIssueState).toHaveBeenCalledWith(500, 'in-progress');
    // Returned so tickOneRepo can start this issue's first slice the same
    // tick, instead of waiting for a listTrackingIssues re-read that can lag
    // behind the label just applied above — see the function's doc comment.
    expect(started).toEqual([
      { number: 500, title: 'Login redirects to 404', url: expect.stringContaining('/issues/500'), labels: ['ronin', 'ronin:issue-fix', 'ronin:in-progress'] },
    ]);
  });

  it('does nothing when there are no newly-assigned issues', async () => {
    listAssignedIssues.mockResolvedValue([]);

    await discoverAssignedIssues();

    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(seedSingleSlice).not.toHaveBeenCalled();
    expect(setIssueState).not.toHaveBeenCalled();
  });

  // Regression: this function runs directly in tick(), outside runIssueStep's
  // safety net, so a failure processing one issue must not escape and
  // abort the whole tick — it must escalate that one issue and move on.
  it('escalates instead of throwing when processing an assigned issue fails', async () => {
    listAssignedIssues.mockResolvedValue([{ number: 501, title: 'Crashes on load' }]);
    addIssueLabel.mockRejectedValueOnce(new Error('gh: HTTP 500'));
    setIssueState.mockResolvedValue(undefined);

    await expect(discoverAssignedIssues()).resolves.toEqual([]);

    expect(notifyBlocker).toHaveBeenCalled();
    expect(setIssueState).toHaveBeenCalledWith(501, 'blocked');
  });
});

describe('processExternalReviewCandidate', () => {
  const candidate = { prNumber: 305, headRefName: 'someone-else/feature-x', headSha: 'abc123', baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true };

  it('runs the external review and records the reviewed SHA on success', async () => {
    runExternalReview.mockResolvedValue(undefined);

    await processExternalReviewCandidate(candidate);

    expect(runExternalReview).toHaveBeenCalledWith(candidate);
    expect(setLastReviewedSha).toHaveBeenCalledWith(305, 'abc123');
  });

  it('does not record the SHA when the review throws', async () => {
    runExternalReview.mockRejectedValue(new Error('claude -p timed out'));

    await expect(processExternalReviewCandidate(candidate)).resolves.toBeUndefined();

    expect(setLastReviewedSha).not.toHaveBeenCalled();
  });

  it('swallows the error instead of propagating it', async () => {
    runExternalReview.mockRejectedValue(new Error('boom'));

    await expect(processExternalReviewCandidate(candidate)).resolves.not.toThrow();
  });

  it('reacts with eyes on each mention that triggered the run, after a successful run', async () => {
    runExternalReview.mockResolvedValue(undefined);
    const withMentions = {
      ...candidate,
      mentions: [{ id: 7, kind: 'issue' as const, body: '@ronin-agent revisá', reactionsEyes: 0, authorLogin: 'someone' }],
    };

    await processExternalReviewCandidate(withMentions);

    expect(addReaction).toHaveBeenCalledWith(7, 'issue', 'eyes');
  });

  it('does not react to mentions when the review throws, so the next tick retries them', async () => {
    runExternalReview.mockRejectedValue(new Error('boom'));
    const withMentions = {
      ...candidate,
      mentions: [{ id: 7, kind: 'issue' as const, body: '@ronin-agent revisá', reactionsEyes: 0, authorLogin: 'someone' }],
    };

    await processExternalReviewCandidate(withMentions);

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('does not react at all when there were no mentions', async () => {
    runExternalReview.mockResolvedValue(undefined);

    await processExternalReviewCandidate(candidate);

    expect(addReaction).not.toHaveBeenCalled();
  });
});

describe('processSpikeCandidate', () => {
  const candidate = {
    issueNumber: 571,
    appName: 'backoffice',
    instruction: 'revisá el flujo de login',
    trigger: [{ id: 7, kind: 'issue' as const, body: '@ronin /spike backoffice revisá el flujo de login', reactionsEyes: 0, authorLogin: 'someone' }],
  };

  it('runs the spike agent task and reacts to the trigger comment on success', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processSpikeCandidate(candidate);

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spike',
      issueNumber: 571,
      appName: 'backoffice',
      instruction: 'revisá el flujo de login',
      trigger: candidate.trigger,
    }));
    expect(addReaction).toHaveBeenCalledWith(7, 'issue', 'eyes');
  });

  it('cleans up the spike worktree on success', async () => {
    runAgentTask.mockResolvedValue(undefined);

    await processSpikeCandidate(candidate);

    expect(removeWorktree).toHaveBeenCalledWith('ronin/571/spike');
  });

  it('does not react to the trigger when the agent task throws, so the next tick retries it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await processSpikeCandidate(candidate);

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('still cleans up the worktree when the agent task throws', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await processSpikeCandidate(candidate);

    expect(removeWorktree).toHaveBeenCalledWith('ronin/571/spike');
  });

  it('swallows the error instead of propagating it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));

    await expect(processSpikeCandidate(candidate)).resolves.not.toThrow();
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

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fix-comments-external',
      prNumber: 599,
      headRefName: 'feat/cambio-cliente',
      trigger: candidate.trigger,
      openThreads: candidate.openThreads,
    }));
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
describe('runScoped', () => {
  const candidate = (prNumber: number) => ({ prNumber, headRefName: 'feature', headSha: `sha${prNumber}`, baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true });

  beforeEach(() => {
    activeRepo.mockReturnValue({ productRepo: 'acme/product' });
    runExternalReview.mockReset().mockResolvedValue(undefined);
    listTrackingIssues.mockReset();
    findPrsNeedingReview.mockReset();
  });

  it("runs only the event's flows, narrowed to its resources", async () => {
    // Even if discovery hands back more, only the event's PR is worked on.
    findPrsNeedingReview.mockResolvedValue({ reviewCandidates: [candidate(41), candidate(42)], trustedFixCandidates: [], threadMentionCandidates: [] });

    await runScoped({ flows: ['review'], resources: ['pr-41'] });

    expect(findPrsNeedingReview).toHaveBeenCalledWith([41]);
    expect(runExternalReview).toHaveBeenCalledTimes(1);
    expect(runExternalReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 41 }));
    // The issue pipeline isn't one of the event's flows: not even listed.
    expect(listTrackingIssues).not.toHaveBeenCalled();
  });
});

describe('runExternalReviews', () => {
  beforeEach(() => {
    runAgentTask.mockResolvedValue(undefined);
    runExternalReview.mockResolvedValue(undefined);
  });

  it('runs one external review per read-only candidate findPrsNeedingReview returns', async () => {
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [
        { prNumber: 305, headRefName: 'someone-else/feature-x', headSha: 'abc123', baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true },
        { prNumber: 306, headRefName: 'other/feature-y', headSha: 'def456', baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true },
      ],
      trustedFixCandidates: [],
      threadMentionCandidates: [],
    });

    await runExternalReviews();

    expect(runExternalReview).toHaveBeenCalledTimes(2);
    expect(runExternalReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 305, headSha: 'abc123' }));
    expect(runExternalReview).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 306, headSha: 'def456' }));
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
      threadMentionCandidates: [],
    });

    await runExternalReviews();

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-comments-external', prNumber: 599, headRefName: 'feat/cambio-cliente' }));
  });

  it('runs at most config.externalReviewConcurrency reviews at once, leaving the other slots to other work', async () => {
    const review = (prNumber: number) => ({ prNumber, headRefName: 'x', headSha: `sha${prNumber}`, baseRefName: 'main', threadHistory: [], openThreads: [], mentions: [], canExecute: true });
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [review(305), review(306)],
      trustedFixCandidates: [{ prNumber: 599, headRefName: 'feat/y', trigger: [], openThreads: [] }],
      threadMentionCandidates: [],
    });
    let reviewsInFlight = 0;
    let maxReviews = 0;
    runExternalReview.mockImplementation(async () => {
      reviewsInFlight++;
      maxReviews = Math.max(maxReviews, reviewsInFlight);
      await new Promise((r) => setTimeout(r, 5));
      reviewsInFlight--;
    });

    await runExternalReviews();

    expect(runExternalReview).toHaveBeenCalledTimes(2);
    expect(maxReviews).toBe(1);
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'fix-comments-external', prNumber: 599 }));
  });

  it('runs one thread-reply-external agent task per thread-mention candidate, and marks each mention 👀 after', async () => {
    const mention = { id: 7, kind: 'review' as const, body: '@ronin aplicá esto', reactionsEyes: 0, authorLogin: 'someone' };
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [],
      trustedFixCandidates: [],
      threadMentionCandidates: [{ prNumber: 600, headRefName: 'feat/z', mentions: [mention] }],
    });

    await runExternalReviews();

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread-reply-external', prNumber: 600, headRefName: 'feat/z', mentions: [mention] }));
    expect(addReaction).toHaveBeenCalledWith(7, 'review', 'eyes');
  });

  it('leaves a thread mention without 👀 when its run fails, so the next tick retries it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [],
      trustedFixCandidates: [],
      threadMentionCandidates: [{ prNumber: 600, headRefName: 'feat/z', mentions: [{ id: 7, kind: 'review' as const, body: '@ronin x', reactionsEyes: 0, authorLogin: 'someone' }] }],
    });

    await expect(runExternalReviews()).resolves.toBeUndefined();

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('does not throw, and runs nothing, when discovery itself fails', async () => {
    findPrsNeedingReview.mockRejectedValue(new Error('gh exploded'));

    await expect(runExternalReviews()).resolves.toBeUndefined();

    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('does nothing when there are no candidates of either kind', async () => {
    findPrsNeedingReview.mockResolvedValue({ reviewCandidates: [], trustedFixCandidates: [], threadMentionCandidates: [] });

    await runExternalReviews();

    expect(runAgentTask).not.toHaveBeenCalled();
  });
});

describe('processChangelogCandidate', () => {
  const release = {
    tagName: 'v1.13.79-odoo',
    name: 'v1.13.79',
    url: 'https://github.com/redmotos/shoppingcart/releases/tag/v1.13.79-odoo',
    publishedAt: '2026-09-12T17:06:10Z',
    isDraft: false,
    isPrerelease: false,
  };

  it('runs the update-changelog agent task and records the release as processed on success', async () => {
    runAgentTask.mockResolvedValue('Pushed to main.\nRONIN_STATUS: done');

    await processChangelogCandidate({ release });

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'update-changelog', release }));
    expect(notifyBlocker).not.toHaveBeenCalled();
    expect(setLastChangelogRelease).toHaveBeenCalledWith('v1.13.79-odoo', '2026-09-12T17:06:10Z');
  });

  it('notifies a blocker and still records the release as processed when the agent task throws', async () => {
    runAgentTask.mockRejectedValue(new Error('claude exploded'));

    await processChangelogCandidate({ release });

    expect(notifyBlocker).toHaveBeenCalledWith(expect.objectContaining({ issueUrl: release.url }));
    expect(setLastChangelogRelease).toHaveBeenCalledWith('v1.13.79-odoo', '2026-09-12T17:06:10Z');
  });
});

describe('runChangelogUpdates', () => {
  it('processes every candidate returned by findReleasesNeedingChangelog', async () => {
    const releaseA = { tagName: 'v1', name: 'v1', url: 'https://x/1', publishedAt: '2026-01-01T00:00:00Z', isDraft: false, isPrerelease: false };
    const releaseB = { tagName: 'v2', name: 'v2', url: 'https://x/2', publishedAt: '2026-01-02T00:00:00Z', isDraft: false, isPrerelease: false };
    findReleasesNeedingChangelog.mockResolvedValue([{ release: releaseA }, { release: releaseB }]);
    runAgentTask.mockResolvedValue('RONIN_STATUS: done');

    await runChangelogUpdates();

    expect(runAgentTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'update-changelog', release: releaseA }));
    expect(runAgentTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'update-changelog', release: releaseB }));
  });

  it('runs one thread-reply-external agent task per thread-mention candidate, and marks each mention 👀 after', async () => {
    const mention = { id: 7, kind: 'review' as const, body: '@ronin aplicá esto', reactionsEyes: 0, authorLogin: 'someone' };
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [],
      trustedFixCandidates: [],
      threadMentionCandidates: [{ prNumber: 600, headRefName: 'feat/z', mentions: [mention] }],
    });

    await runExternalReviews();

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread-reply-external', prNumber: 600, headRefName: 'feat/z', mentions: [mention] }));
    expect(addReaction).toHaveBeenCalledWith(7, 'review', 'eyes');
  });

  it('leaves a thread mention without 👀 when its run fails, so the next tick retries it', async () => {
    runAgentTask.mockRejectedValue(new Error('boom'));
    findPrsNeedingReview.mockResolvedValue({
      reviewCandidates: [],
      trustedFixCandidates: [],
      threadMentionCandidates: [{ prNumber: 600, headRefName: 'feat/z', mentions: [{ id: 7, kind: 'review' as const, body: '@ronin x', reactionsEyes: 0, authorLogin: 'someone' }] }],
    });

    await expect(runExternalReviews()).resolves.toBeUndefined();

    expect(addReaction).not.toHaveBeenCalled();
  });

  it('does not throw, and runs nothing, when discovery itself fails', async () => {
    findReleasesNeedingChangelog.mockRejectedValue(new Error('gh exploded'));

    await expect(runChangelogUpdates()).resolves.toBeUndefined();

    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('does nothing when there are no candidates', async () => {
    findReleasesNeedingChangelog.mockResolvedValue([]);

    await runChangelogUpdates();

    expect(runAgentTask).not.toHaveBeenCalled();
  });
});

describe('idleCommandJobs', () => {
  it('reads the commands on slice PRs whose issue is not in progress, and only those', async () => {
    findUnprocessedMentions.mockReset().mockResolvedValue([]);
    const prs = [
      { number: 367, headRefName: 'ronin/350/slice-1' },
      { number: 374, headRefName: 'ronin/361/slice-1' },
      { number: 380, headRefName: 'ronin/exploration/2026-10-14' },
    ] as any[];

    const jobs = idleCommandJobs(prs, [{ number: 361 }] as any[]);
    for (const job of jobs) await job.run();

    expect(findUnprocessedMentions.mock.calls).toEqual([[367]]);
    // An event on the PR or on its issue finds this job.
    expect(jobs[0]).toMatchObject({ lock: 'pr-367', resources: ['pr-367', 'issue-350'] });
  });

  it('keeps going when one PR fails', async () => {
    findUnprocessedMentions.mockReset().mockRejectedValueOnce(new Error('gh down')).mockResolvedValue([]);

    const jobs = idleCommandJobs([{ number: 1, headRefName: 'ronin/10/slice-1' }, { number: 2, headRefName: 'ronin/11/slice-2' }] as any[], []);
    for (const job of jobs) await job.run();

    expect(findUnprocessedMentions.mock.calls).toEqual([[1], [2]]);
  });
});

describe('specRevisionJobs (#241)', () => {
  it('makes one job per draft spec PR with mentions to answer, found by an event on the PR or on its issue', async () => {
    const mention = { id: 9, kind: 'review', body: '@ronin-agent sumá esto', reactionsEyes: 0, authorLogin: 'persona' };
    findUnprocessedMentions.mockReset().mockImplementation(async (n: number) => (n === 1027 ? [mention] : []));
    const prs = [
      { number: 1027, headRefName: 'ronin/1026/spec', isDraft: true },
      { number: 1030, headRefName: 'ronin/1029/spec', isDraft: false },
      { number: 1031, headRefName: 'ronin/1028/slice-1', isDraft: true },
    ] as any[];

    const jobs = await specRevisionJobs(prs);

    expect(findUnprocessedMentions.mock.calls).toEqual([[1027]]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'revise-spec', lock: 'pr-1027', resources: ['pr-1027', 'issue-1026'] });
  });
});

describe('runIssueStep', () => {
  const issue = { number: 350, title: 't', url: 'u', labels: ['ronin', 'ronin:attempts-3'] };

  beforeEach(() => {
    resetAttemptCount.mockReset().mockResolvedValue(undefined);
    isTransientGhError.mockReset().mockReturnValue(false);
    incrementAttemptCount.mockReset().mockResolvedValue(1);
    setIssueState.mockReset().mockResolvedValue(undefined);
  });

  it('resets the error counter when the step goes through', async () => {
    await runIssueStep(issue, async () => {});
    expect(resetAttemptCount).toHaveBeenCalledWith(350, 3);
  });

  it('leaves an issue without a counter alone', async () => {
    await runIssueStep({ ...issue, labels: ['ronin'] }, async () => {});
    expect(resetAttemptCount).not.toHaveBeenCalled();
  });

  it('does not count a transient GitHub error, nor block on it', async () => {
    isTransientGhError.mockReturnValue(true);
    await runIssueStep(issue, async () => { throw new Error('Command failed: gh issue view 350\nHTTP 500: 500 Internal Server Error'); });
    expect(incrementAttemptCount).not.toHaveBeenCalled();
    expect(setIssueState).not.toHaveBeenCalled();
    expect(resetAttemptCount).not.toHaveBeenCalled();
  });

  it('still counts any other error', async () => {
    await runIssueStep(issue, async () => { throw new Error('claude exited with code 1'); });
    expect(incrementAttemptCount).toHaveBeenCalledWith(350);
  });
});
