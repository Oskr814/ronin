# Bottom-Only CI Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `processSlicePr` (`src/tick.ts`) from evaluating CI checks (`checksPending`/`checksPassing`, `fix-e2e` escalation) on stacked PRs that aren't the bottom of the stack, since bmedical's pipeline only runs against PRs whose `base` is `main` and non-bottom PRs never have that base.

**Architecture:** Single-function reorder inside `src/tick.ts`. No new modules, no changes to `stack.ts`, `github.ts`, or `config.ts`. `processSlicePr` becomes exported so a new `src/tick.test.ts` can unit-test it directly with mocked dependencies (the existing pattern in `mentions.test.ts`/`stack.test.ts`).

**Tech Stack:** TypeScript, Vitest (`vi.mock` module mocking, already a devDependency — see `package.json`).

## Global Constraints

- Behavior for the bottom-of-stack PR must not change at all (merge, checks escalation, `fix-e2e`, `ensureBottomUpToDate`) — verified by regression tests, not just by inspection.
- `reviewDecision === 'CHANGES_REQUESTED'` → `fix-review` must keep firing regardless of stack position (this is not CI-dependent).
- No changes outside `src/tick.ts` and its new test file.
- Spec: `docs/superpowers/specs/2026-07-28-bottom-only-checks-design.md`.

---

### Task 1: Export `processSlicePr` and add a failing regression test for non-bottom checks

**Files:**
- Modify: `src/tick.ts:185` (add `export` to `processSlicePr`)
- Create: `src/tick.test.ts`

**Interfaces:**
- Consumes: `processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean): Promise<boolean>` (existing signature, `src/tick.ts:185`) — will be exported, not changed in shape.
- Consumes for mocking: `recordSlicePr`, `markSliceMerged` from `./checklist.js`; `hasEvidenceComment`, `postEvidenceComment`, `addReaction`, `mergePullRequest`, `incrementAttemptCount` from `./github.js`; `publishEvidence`, `rawEvidenceUrl` from `./evidence.js`; `worktreeDirFor`, `isBehind`, `attemptRebase` from `./worktree.js`; `findUnprocessedMentions` from `./mentions.js`; `runAgentTask` from `./agent-task.js`; `notifyBlocker` from `./notifier.js`; `config` from `./config.js`.
- Produces: nothing new for later tasks — Task 2 only touches `src/tick.ts` control flow, not its exports or types.

- [ ] **Step 1: Export `processSlicePr`**

In `src/tick.ts:185`, change:

```ts
async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean): Promise<boolean> {
```

to:

```ts
export async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean): Promise<boolean> {
```

- [ ] **Step 2: Write `src/tick.test.ts` with mocks and a base PR/issue factory**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackingIssue, PullRequestStatus } from './github.js';
import type { StackedPr } from './stack.js';

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
vi.mock('./github.js', () => ({
  hasEvidenceComment: (...args: unknown[]) => hasEvidenceComment(...args),
  postEvidenceComment: (...args: unknown[]) => postEvidenceComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  incrementAttemptCount: (...args: unknown[]) => incrementAttemptCount(...args),
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

function pr(overrides: Partial<PullRequestStatus> = {}): StackedPr {
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
```

- [ ] **Step 3: Run the new test and confirm it fails against current code**

Run: `pnpm vitest run src/tick.test.ts`
Expected: FAIL — `incrementAttemptCount` (or `notifyBlocker`) was called, because current code still evaluates `pr.checksPending` for non-bottom PRs and escalates once `e2eRetryLimit` (2) is exceeded... actually with `incrementAttemptCount` mocked to return `1` (≤ limit of 2), `blockOnAttemptLimit` returns `false`, so the assertion that fails is `expect(runAgentTask).not.toHaveBeenCalled()` being satisfied but `expect(incrementAttemptCount).not.toHaveBeenCalled()` failing, since current code calls it unconditionally for a non-bottom PR with `checksPending: true`.

- [ ] **Step 4: Commit the test (still red)**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "test: lock non-bottom stacked PRs out of CI-check escalation"
```

---

### Task 2: Gate checks evaluation to the bottom-of-stack PR

**Files:**
- Modify: `src/tick.ts:224-278` (body of `processSlicePr`, after the mentions early-return)
- Test: `src/tick.test.ts` (add three more cases)

**Interfaces:**
- Consumes: same `processSlicePr` export from Task 1, no signature change.
- Produces: nothing new — this is the last task in the plan.

- [ ] **Step 1: Reorder the body of `processSlicePr`**

Replace `src/tick.ts:224-278` (from the "Solo el fondo del stack..." comment through the final `return true;`) with:

```ts
  // Solo el fondo del stack necesita estar al día con main antes de evaluar
  // merge — ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md §5.
  if (isBottom) {
    const status = await ensureBottomUpToDate(issue, pr);
    if (status === 'blocked') return false;
    if (status === 'not-ready') return true;

    if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
      await mergePullRequest(pr.number);
      await markSliceMerged(issue.number, pr.sliceIndex);
      return true;
    }
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.sliceAttemptLimit,
      'Feedback de review sin converger tras el límite de intentos',
    );
    if (blocked) return false;
    await runAgentTask({ type: 'fix-review', issueNumber: issue.number, prNumber: pr.number });
    return true;
  }

  // bmedical's CI pipeline only runs against PRs targeting `main`; a
  // non-bottom stacked PR's base is always another slice's branch, so it
  // never gets a statusCheckRollup at all. Evaluating checksPending for it
  // would escalate forever on a state that's actually just "waiting its
  // turn" — see docs/superpowers/specs/2026-07-28-bottom-only-checks-design.md.
  if (!isBottom) return true;

  // CI still running (queued/in-progress) reads the same as checksPassing
  // === false — wait for it instead of treating it as an actual failure, so
  // in-flight checks don't trigger a spurious fix-e2e / attempt increment.
  // See final review Fix 6. Bounded by the same attempt limit as the actual
  // e2e-failure path below (and sharing its counter) so a rollup that never
  // reports anything — e.g. a path-filtered workflow that never triggers for
  // this slice — still escalates instead of waiting forever in silence.
  if (pr.checksPending) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'CI nunca reportó resultados tras el límite de reintentos',
    );
    return !blocked;
  }

  if (!pr.checksPassing) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'E2E fallando persistentemente tras el límite de reintentos',
    );
    if (blocked) return false;
    await runAgentTask({ type: 'fix-e2e', issueNumber: issue.number, prNumber: pr.number });
    return true;
  }

  // Checks passing, no changes requested, not yet approved: normal
  // waiting-for-review state per docs/BLOCKING.md — no action, no notification.
  return true;
}
```

Note the removed line (previously right after the `checksPassing && APPROVED` check): `if (!isBottom) return true;` guarding only the merge branch — it's now redundant because that whole block sits inside `if (isBottom)`.

- [ ] **Step 2: Run the Task 1 test and confirm it now passes**

Run: `pnpm vitest run src/tick.test.ts`
Expected: PASS

- [ ] **Step 3: Add the three remaining regression cases to `src/tick.test.ts`**

Append to the file:

```ts
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
```

- [ ] **Step 4: Run the full test file**

Run: `pnpm vitest run src/tick.test.ts`
Expected: PASS (all four `it` blocks)

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "fix: only evaluate CI checks for the bottom-of-stack PR

Non-bottom stacked PRs never target main, so bmedical's pipeline never
runs on them and checksPending stayed true forever, falsely escalating
via blockOnAttemptLimit after e2eRetryLimit ticks."
```
