# Bug Issue Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human trigger ValerIA on a plain GitHub bug-report issue (label `bugfix` + `valeria:runner-<id>`) and have it investigate, fix, and open a PR — reusing the existing spec/slice engine instead of building a parallel pipeline.

**Architecture:** The bug issue itself becomes the tracking issue (no mirror issue is created, unlike specs). A new discovery pass seeds it with a mechanical single-slice checklist and flips it to `valeria:in-progress`; from there `processIssue`/`processSlicePr` in `tick.ts` drive it exactly like a spec's tracking issue (merge gate, `fix-review`/`fix-e2e` cycles, evidence publishing) — the only new runtime piece is a `fix-bug` agent task with a prompt tailored to "read this issue, find the root cause, fix it," instead of "implement this spec slice."

**Tech Stack:** TypeScript, Node.js, Vitest, `gh` CLI (GitHub REST via `gh issue`/`gh pr`).

## Global Constraints

- Reuse the existing `bugfix` label already present in `bmedical` — do not create a new label for "this is a bug" (design decision, see spec's "Fuera de alcance").
- No new tracking issue is created for a bug — the reported issue itself carries the `valeria:*` state labels (see spec, "El issue de bug ES el issue de tracking").
- A bug issue is always exactly one slice — no slicing logic changes in `stack.ts`.
- Every new/changed function must match this codebase's existing style: no comments explaining *what* the code does, only non-obvious *why* (see the surrounding code in every file touched below for the bar to match).
- Full spec: `docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md`. Re-read it if anything below seems ambiguous — the plan is a derivation of it, not a replacement.

---

### Task 1: `seedSingleSlice` in checklist.ts

**Files:**
- Modify: `src/checklist.ts`
- Test: `src/checklist.test.ts`

**Interfaces:**
- Consumes: `getIssueBody`, `setIssueBody` (already imported in `checklist.ts` from `./github.js`); the file's own private `renderLine` and exported `getSlices`.
- Produces: `export async function seedSingleSlice(issueNumber: number, title: string): Promise<void>` — appends a `## Slices` section with one unchecked, un-PR'd slice to an issue's body. Idempotent: a second call on an issue that already has any slice line does nothing. Consumed by `tick.ts`'s `discoverAssignedBugs` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `src/checklist.test.ts`, after the existing `recordSlicePr / markSliceMerged` describe block:

```ts
describe('seedSingleSlice', () => {
  it('appends a single-slice "## Slices" section to an existing body', async () => {
    bodies.set(500, '## Bug report\n\nSteps to reproduce...');

    await seedSingleSlice(500, 'Fix — Login redirects to 404');

    expect(bodies.get(500)).toBe(
      '## Bug report\n\nSteps to reproduce...\n\n## Slices\n\n- [ ] Slice 1: Fix — Login redirects to 404 — PR: _pending_\n',
    );
  });

  it('is idempotent — does nothing once a Slices section already exists', async () => {
    bodies.set(228, SAMPLE_BODY);

    await seedSingleSlice(228, 'irrelevant');

    expect(bodies.get(228)).toBe(SAMPLE_BODY);
    expect(setIssueBody).not.toHaveBeenCalled();
  });
});
```

Update the import line near the top of the file to include the new function:

```ts
import { nextSlice, nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged, seedSingleSlice } from './checklist.js';
```

You'll also need `setIssueBody` available as a reference in the test for the second assertion — it's already the mocked `vi.fn()` returned by the `vi.mock('./github.js', ...)` block at the top of the file, just add it to that block's destructure if not already accessible (check: the mock object already defines `setIssueBody: vi.fn(...)` inline — capture it in a named const the same way the file does for none currently, so simplest is to reference `vi.mocked` — instead, add a top-level `const setIssueBody = vi.fn(...)` and use it inside the `vi.mock` factory, mirroring the pattern `tick.test.ts` uses for its mocks):

```ts
const bodies = new Map<number, string>();
const setIssueBody = vi.fn(async (issueNumber: number, body: string) => {
  bodies.set(issueNumber, body);
});

vi.mock('./github.js', () => ({
  getIssueBody: vi.fn(async (issueNumber: number) => bodies.get(issueNumber) ?? ''),
  setIssueBody: (...args: [number, string]) => setIssueBody(...args),
}));
```

(This replaces the current inline `setIssueBody: vi.fn(...)` — same behavior, just now referenceable by the new test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk npx vitest run src/checklist.test.ts`
Expected: FAIL — `seedSingleSlice is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `seedSingleSlice`**

Add to `src/checklist.ts`, after `markSliceMerged`:

```ts
// Used by the bug-issue intake path (docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md)
// to turn a plain bug-report issue into something nextUnstartedSlice/
// hasRemainingSlices can drive, without an LLM planning session — a bug is
// always exactly one slice, built mechanically. Checking getSlices first
// (rather than string-scanning for "## Slices") makes this safe to retry
// after a tick that failed partway through discovery.
export async function seedSingleSlice(issueNumber: number, title: string): Promise<void> {
  if ((await getSlices(issueNumber)).length > 0) return;
  const body = await getIssueBody(issueNumber);
  const section = `\n\n## Slices\n\n${renderLine({ index: 0, title, checked: false, prNumber: null })}\n`;
  await setIssueBody(issueNumber, body + section);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `rtk npx vitest run src/checklist.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/checklist.ts src/checklist.test.ts
git commit -m "feat: seed a mechanical single-slice checklist for bug issues"
```

---

### Task 2: `LABEL_BUG` constant

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Produces: `export const LABEL_BUG = 'bugfix';` — consumed by `src/github.ts` (Task 3) and `src/tick.ts` (Task 5).

- [ ] **Step 1: Add the constant**

In `src/config.ts`, right after the `LABEL_STATES` block:

```ts
export const LABEL_MANAGED = 'valeria';
export const LABEL_STATES = {
  ready: 'valeria:ready',
  'in-progress': 'valeria:in-progress',
  blocked: 'valeria:blocked',
  done: 'valeria:done',
} as const;

// bmedical's own pre-existing label ("Something isn't working") — reused as
// the bug-intake trigger instead of a new valeria:-prefixed label, see
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
export const LABEL_BUG = 'bugfix';

export type SpecStatus = keyof typeof LABEL_STATES;
```

- [ ] **Step 2: Type-check**

Run: `rtk npx tsc --noEmit -p tsconfig.json`
Expected: no errors (nothing consumes `LABEL_BUG` yet, but an unused export is not a type error).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add LABEL_BUG constant for bug-issue intake"
```

---

### Task 3: `listAssignedBugIssues` in github.ts

**Files:**
- Modify: `src/github.ts`

**Interfaces:**
- Consumes: `LABEL_BUG`, `LABEL_MANAGED` from `./config.js`; the file's own `gh` helper.
- Produces:
  ```ts
  export interface BugIssue {
    number: number;
    title: string;
  }
  export async function listAssignedBugIssues(label: string): Promise<BugIssue[]>
  ```
  Consumed by `tick.ts`'s `discoverAssignedBugs` (Task 5), called the same way `listAssignedSpecPrs(runnerLabel())` already is.

- [ ] **Step 1: Update the config import**

In `src/github.ts`, change:

```ts
import { config, LABEL_MANAGED, LABEL_STATES, type SpecStatus } from './config.js';
```

to:

```ts
import { config, LABEL_MANAGED, LABEL_STATES, LABEL_BUG, type SpecStatus } from './config.js';
```

- [ ] **Step 2: Add `BugIssue` and `listAssignedBugIssues`**

Add after `listAssignedSpecPrs` (around line 326):

```ts
export interface BugIssue {
  number: number;
  title: string;
}

// Discovery source of truth for the bug-intake path: an issue is ready for
// this runner once a human has applied both bmedical's own `bugfix` label
// and this runner's assignment label (see claim.ts's runnerLabel) — no
// draft/ready step like a spec PR has, since a GitHub issue has no draft
// state. Already-managed issues (label `valeria` present) are excluded so
// an issue is only ever picked up once. See
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
export async function listAssignedBugIssues(label: string): Promise<BugIssue[]> {
  const stdout = await gh([
    'issue', 'list',
    '--label', LABEL_BUG,
    '--label', label,
    '--state', 'open',
    '--json', 'number,title,labels',
  ]);
  const raw = JSON.parse(stdout) as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  return raw
    .filter((issue) => !issue.labels.some((l) => l.name === LABEL_MANAGED))
    .map((issue) => ({ number: issue.number, title: issue.title }));
}
```

- [ ] **Step 3: Type-check**

Run: `rtk npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/github.ts
git commit -m "feat: list bug issues assigned to this runner"
```

(No dedicated test file for `github.ts` exists in this codebase today — its functions are thin `gh` CLI wrappers, and the existing convention, e.g. `listAssignedSpecPrs`, leaves them covered indirectly through `tick.ts`'s tests rather than unit-tested in isolation. Follow that precedent here.)

---

### Task 4: `fix-bug` agent task

**Files:**
- Modify: `src/agent-task.ts`

**Interfaces:**
- Consumes: `sliceBranch` (already imported from `./stack.js`), `config` (already imported from `./config.js`), `repoUrl()` (private helper already in this file).
- Produces: new `AgentTask` union member `{ type: 'fix-bug'; issueNumber: number; sliceIndex: number; sliceTitle: string }`. Consumed by `tick.ts`'s `agentTaskFor` (Task 5) and `runAgentTask` (unchanged, already generic over `AgentTask`).

- [ ] **Step 1: Extend the `AgentTask` union**

In `src/agent-task.ts`, change:

```ts
export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPaths: string[] }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number; sliceTitle: string }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number }
  | { type: 'fix-rebase'; issueNumber: number; prNumber: number }
  | { type: 'review-request'; issueNumber: number; prNumber: number; mentions: Comment[] };
```

to:

```ts
export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPaths: string[] }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number; sliceTitle: string }
  | { type: 'fix-bug'; issueNumber: number; sliceIndex: number; sliceTitle: string }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number }
  | { type: 'fix-rebase'; issueNumber: number; prNumber: number }
  | { type: 'review-request'; issueNumber: number; prNumber: number; mentions: Comment[] };
```

- [ ] **Step 2: Add the `fix-bug` case to `buildTask`**

Add a new `case 'fix-bug':` in the `switch (task.type)` inside `buildTask`, right after the `case 'implement-slice':` block closes (after its closing `}`):

```ts
    case 'fix-bug': {
      // Always slice 0 — a bug issue is seeded with exactly one slice
      // (checklist.ts's seedSingleSlice), so unlike implement-slice this
      // never needs baseBranchFor's "stack on the previous slice" logic or
      // its remote-branch-missing fallback.
      return {
        branch: sliceBranch(task.issueNumber, task.sliceIndex),
        baseBranch: config.worktreeBaseRef,
        prompt: [
          `You are ValerIA, an autonomous agent working on issue #${task.issueNumber} in ${repoUrl()}, labeled "bugfix".`,
          `Read the full issue, including comments: "gh issue view ${task.issueNumber} --comments".`,
          'Explore the repository to find the root cause — do not guess or fabricate a fix without evidence. If the issue lacks enough information to reproduce the problem, or is ambiguous, comment on the issue asking for what you need ("gh issue comment") and stop without touching any code — that needs a human answer.',
          "Once you've found the root cause, fix it following this repo's CLAUDE.md conventions, including its testing requirements.",
          'If this bug touches user-facing behavior in apps/webapp, add or update a Playwright e2e spec under apps/webapp/e2e/ covering it, and run it (`pnpm --filter @bmedical/webapp exec playwright test`) until it passes — do not leave that for CI to catch. Leave the resulting output under apps/webapp/test-results/ as-is; do not move, copy, or commit it — the supervisor collects it separately.',
          `When done: run the relevant tests, and make exactly one commit for this fix. Push this branch and open a PR ("gh pr create") with "Closes #${task.issueNumber}" in the body, describing the root cause and the fix.`,
          'Scope: only touch files needed for this fix. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```

- [ ] **Step 3: Type-check**

Run: `rtk npx tsc --noEmit -p tsconfig.json`
Expected: no errors — `buildTask`'s switch is exhaustive over `AgentTask['type']`, so a missing case would be a compile error; this confirms the new case is wired correctly.

- [ ] **Step 4: Commit**

```bash
git add src/agent-task.ts
git commit -m "feat: add fix-bug agent task"
```

(No dedicated test file for `agent-task.ts` exists today — same rationale as Task 3.)

---

### Task 5: Wire discovery, routing, and the same-tick done fix into tick.ts

**Files:**
- Modify: `src/tick.ts`
- Test: `src/tick.test.ts`

**Interfaces:**
- Consumes: `listAssignedBugIssues`, `BugIssue` (Task 3, from `./github.js`), `LABEL_BUG` (Task 2, from `./config.js`), `seedSingleSlice` (Task 1, from `./checklist.js`), `type AgentTask` (Task 4, from `./agent-task.js`).
- Produces: `export function agentTaskFor(issue: TrackingIssue, sliceIndex: number, sliceTitle: string): AgentTask` — exported for direct unit testing, same rationale as `processSlicePr` already being exported.

- [ ] **Step 1: Write the failing tests**

In `src/tick.test.ts`:

1. Add `hasRemainingSlices` to the `./checklist.js` mock block and give it a default in `beforeEach` (existing merge tests don't currently exercise this path, so they need a safe default that preserves today's behavior):

```ts
const recordSlicePr = vi.fn();
const markSliceMerged = vi.fn();
const hasRemainingSlices = vi.fn();
vi.mock('./checklist.js', () => ({
  recordSlicePr: (...args: unknown[]) => recordSlicePr(...args),
  markSliceMerged: (...args: unknown[]) => markSliceMerged(...args),
  hasRemainingSlices: (...args: unknown[]) => hasRemainingSlices(...args),
}));
```

```ts
beforeEach(() => {
  vi.clearAllMocks();
  recordSlicePr.mockResolvedValue(undefined);
  hasEvidenceComment.mockResolvedValue(true); // skip publishEvidence path
  findUnprocessedMentions.mockResolvedValue([]);
  worktreeDirFor.mockReturnValue('/tmp/worktree');
  incrementAttemptCount.mockResolvedValue(1);
  existsSync.mockReturnValue(true);
  hasRemainingSlices.mockResolvedValue(true); // preserves pre-existing merge test behavior by default
});
```

2. Add `LABEL_BUG: 'bugfix'` to the `./config.js` mock:

```ts
vi.mock('./config.js', () => ({
  config: {
    e2eRetryLimit: 2,
    sliceAttemptLimit: 3,
    rebaseRetryLimit: 3,
    worktreeBaseRef: 'origin/main',
    productRepo: 'bmedical/bmedical',
  },
  LABEL_BUG: 'bugfix',
}));
```

3. Update the import line to also pull `agentTaskFor`:

```ts
const { processSlicePr, agentTaskFor } = await import('./tick.js');
```

4. Add two new describe blocks, anywhere after the existing ones:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk npx vitest run src/tick.test.ts`
Expected: FAIL — `agentTaskFor` is not exported yet, and the two new merge tests fail because `setIssueState(228, 'done')` is never called yet.

- [ ] **Step 3: Update imports**

At the top of `src/tick.ts`, change:

```ts
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  getOpenPrsForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  addReaction,
  getPullRequestStatus,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './spec-content.js';
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask } from './agent-task.js';
import { ClaudeUsageLimitError } from './claude-runner.js';
import { toStackedPrs, pickBottomPr, type StackedPr } from './stack.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor, isBehind, attemptRebase } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { findUnprocessedMentions } from './mentions.js';
import { config } from './config.js';
import { log } from './logger.js';
```

to:

```ts
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  listAssignedBugIssues,
  addIssueLabel,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  getOpenPrsForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  addReaction,
  getPullRequestStatus,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './spec-content.js';
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged, seedSingleSlice } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask, type AgentTask } from './agent-task.js';
import { ClaudeUsageLimitError } from './claude-runner.js';
import { toStackedPrs, pickBottomPr, type StackedPr } from './stack.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor, isBehind, attemptRebase } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { findUnprocessedMentions } from './mentions.js';
import { config, LABEL_BUG } from './config.js';
import { log } from './logger.js';
```

- [ ] **Step 4: Add `discoverAssignedBugs`**

Add after `discoverAssignedSpecs` (right after its closing `}`, before `blockOnAttemptLimit`):

```ts
function issueUrl(issueNumber: number): string {
  return `https://github.com/${config.productRepo}/issues/${issueNumber}`;
}

// Discovery source: a human labels an existing bug-report issue (already
// carrying bmedical's own `bugfix` label) with this runner's assignment
// label — same "andá" signal as a spec PR's runner label, but without a
// draft/ready step, since a GitHub issue has no draft state. Unlike specs,
// no mirror tracking issue is created: the bug issue itself becomes the
// tracked unit, seeded with a single-slice checklist so the rest of the
// pipeline (merge gate, fix-review/fix-e2e cycles, evidence) treats it
// exactly like a spec's tracking issue. See
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
async function discoverAssignedBugs(): Promise<void> {
  const bugs = await listAssignedBugIssues(runnerLabel());
  for (const bug of bugs) {
    try {
      // Added first, before anything else can fail, so a partial failure
      // still leaves the issue valeria-managed (and therefore reachable via
      // listTrackingIssues once set to blocked below) instead of retried
      // forever as "not yet picked up".
      await addIssueLabel(bug.number, LABEL_MANAGED);
      await seedSingleSlice(bug.number, `Fix — ${bug.title}`);
      await setIssueState(bug.number, 'in-progress');
    } catch (error) {
      await notifyBlocker({
        issueUrl: issueUrl(bug.number),
        reason: `Excepción no manejada procesando el issue de bug: ${(error as Error).message}`,
      });
      await setIssueState(bug.number, 'blocked').catch(() => {});
    }
  }
}
```

This introduces a new dependency on `LABEL_MANAGED` — update the `config.js` import once more (Step 3's edit already switched to a named-import style, so this is a small follow-up in the same line):

```ts
import { config, LABEL_BUG, LABEL_MANAGED } from './config.js';
```

- [ ] **Step 5: Call it from `tick()`**

In `src/tick.ts`, inside `export async function tick(): Promise<void> {`, change:

```ts
  log.info(`tick start (commit ${await currentCommit()})`);
  await discoverAssignedSpecs();
```

to:

```ts
  log.info(`tick start (commit ${await currentCommit()})`);
  await discoverAssignedSpecs();
  await discoverAssignedBugs();
```

- [ ] **Step 6: Add `agentTaskFor` and route both `implement-slice` call sites through it**

Add near the top of `src/tick.ts`, right after `primarySpecPath` (or any other convenient top-level helper — placement isn't load-bearing, just keep it near the other small pure helpers):

```ts
// A bug issue (bugfix label — see docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md)
// and a spec's tracking issue share the exact same slice-checklist
// machinery; this is the one place that decides which agent prompt a given
// slice actually needs. Exported for direct unit testing.
export function agentTaskFor(issue: TrackingIssue, sliceIndex: number, sliceTitle: string): AgentTask {
  return issue.labels.includes(LABEL_BUG)
    ? { type: 'fix-bug', issueNumber: issue.number, sliceIndex, sliceTitle }
    : { type: 'implement-slice', issueNumber: issue.number, sliceIndex, sliceTitle };
}
```

In `processIssue`, change:

```ts
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      log.info(`issue #${issue.number}: sin PRs abiertos, arrancando slice ${slice.index + 1} (${slice.title})`);
      await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: slice.index, sliceTitle: slice.title });
      return;
    }
```

to:

```ts
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      log.info(`issue #${issue.number}: sin PRs abiertos, arrancando slice ${slice.index + 1} (${slice.title})`);
      await runAgentTask(agentTaskFor(issue, slice.index, slice.title));
      return;
    }
```

And later in the same function, change:

```ts
  const nextUnstarted = await nextUnstartedSlice(issue.number);
  if (nextUnstarted) {
    log.info(`issue #${issue.number}: stack de ${stack.length} PR(s) abierto(s), arrancando slice ${nextUnstarted.index + 1} (${nextUnstarted.title}) en paralelo`);
    await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: nextUnstarted.index, sliceTitle: nextUnstarted.title });
  }
```

to:

```ts
  const nextUnstarted = await nextUnstartedSlice(issue.number);
  if (nextUnstarted) {
    log.info(`issue #${issue.number}: stack de ${stack.length} PR(s) abierto(s), arrancando slice ${nextUnstarted.index + 1} (${nextUnstarted.title}) en paralelo`);
    await runAgentTask(agentTaskFor(issue, nextUnstarted.index, nextUnstarted.title));
  }
```

- [ ] **Step 7: Close the same-tick done gap in `processSlicePr`**

In `src/tick.ts`, inside `processSlicePr`, change:

```ts
    if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
      await mergePullRequest(pr.number);
      await markSliceMerged(issue.number, pr.sliceIndex);
      logSliceOutcome(issue, pr, isBottom, 'mergeado');
      return true;
    }
```

to:

```ts
    if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
      await mergePullRequest(pr.number);
      await markSliceMerged(issue.number, pr.sliceIndex);
      // Closes a one-tick gap: a bug-fix PR's "Closes #N" (see
      // docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md) makes
      // GitHub close the issue on merge, and listTrackingIssues filters
      // --state open — without this, the next tick would never see the
      // issue again to notice no slices remain, leaving it
      // valeria:in-progress forever. Also shaves a tick off `done` for
      // ordinary specs, harmlessly.
      if (!(await hasRemainingSlices(issue.number))) await setIssueState(issue.number, 'done');
      logSliceOutcome(issue, pr, isBottom, 'mergeado');
      return true;
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `rtk npx vitest run src/tick.test.ts`
Expected: PASS, all tests in the file, including the four new ones.

- [ ] **Step 9: Type-check and full test suite**

Run: `rtk npx tsc --noEmit -p tsconfig.json && rtk npx vitest run`
Expected: no type errors; all test files pass.

- [ ] **Step 10: Commit**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "feat: discover and drive bug issues through the slice pipeline"
```

---

### Task 6: Document the new intake path

**Files:**
- Modify: `docs/DESIGN.md`

- [ ] **Step 1: Add a short paragraph to §1**

In `docs/DESIGN.md`, find the end of section `### 1. Descubrimiento de specs` (right before the `### 2. Mapeo a GitHub` heading) and add:

```markdown
**Variante: issues de bug.** Un issue ya existente en el repo del producto, etiquetado
con la label propia de `bugfix` (ya existente en el repo) y `valeria:runner-<id>`, se
toma con la misma señal de asignación manual que un spec PR, pero sin paso de
draft/ready (un issue de GitHub no tiene estado draft). A diferencia de un spec, no se
crea un issue de tracking espejo — el issue de bug pasa a ser directamente la unidad de
tracking, sembrado con un checklist mecánico de una sola slice para que el resto del
motor (merge gate, ciclos `fix-review`/`fix-e2e`, evidencia) lo trate igual que la
tracking issue de un spec. Ver
[`docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md`](superpowers/specs/2026-07-28-bug-issue-intake-design.md).
```

- [ ] **Step 2: Commit**

```bash
git add docs/DESIGN.md
git commit -m "docs: document the bug-issue intake path in DESIGN.md"
```

---

### Task 7: Build and final verification

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `rtk pnpm build`
Expected: no errors (`tsc -p tsconfig.build.json` succeeds).

- [ ] **Step 2: Full test suite**

Run: `rtk npx vitest run`
Expected: all test files pass, including the new/updated `checklist.test.ts` and `tick.test.ts` cases.

- [ ] **Step 3: Manual label check (no code — verification only)**

Confirm the `bugfix` label already exists in `bmedical` (it does — already used elsewhere in the repo) and that this runner's assignment label exists too:

```bash
gh label list --repo Bmedical/bmedical --search bugfix
gh label list --repo Bmedical/bmedical --search valeria:runner
```

Expected: both present. No new label needs to be created by this feature — `ensureLabel` inside `addIssueLabel`/`setIssueState` (Task 5) only ever needs to create `valeria` and `valeria:in-progress` if they don't already exist, which they do (used since the spec-PR flow already runs).
