# ronin Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every internal "valeria"/"ValerIA" symbol, label, branch prefix, path, and prompt string in the codebase to "ronin", consistent with the repo name and the `RONIN_GITHUB_*` identity already established.

**Architecture:** Pure mechanical rename — no new logic, no compatibility shims (confirmed: nothing in production to migrate). Each task renames one module's symbols/strings and its own test file in the same commit, so the suite stays green after every task.

**Tech Stack:** TypeScript (Node, ESM), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-ronin-rebrand-design.md`

## Global Constraints

- Casing convention: lowercase `ronin` everywhere — labels (`ronin:ready`), branches (`ronin/<issue>/...`), email subject (`[ronin]`), README title (`# ronin`). Never `Ronin` or `RONIN` outside actual env var names (`RONIN_REPO`, which follows the existing `RONIN_GITHUB_*` convention).
- `RONIN_REPO`'s default changes from `Bmedical/ValerIA` to `Oskr814/ronin` (confirmed).
- `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` (all of them, including the ones already about ronin) are OUT OF SCOPE — never edited by this plan. They're dated historical record.
- Within `docs/DESIGN.md`, section "### 10. Primer dry run (2026-07-28)" is also OUT OF SCOPE — it's a dated historical log entry documenting a specific past test run (what it actually said and did at the time), not living documentation. Every other section of `docs/DESIGN.md` IS in scope.
- No behavior changes. Every rename is a 1:1 string/regex substitution — if a diff does anything other than substitute `valeria`→`ronin`/`ValerIA`→`ronin` (case-sensitively, per the table below) plus directly adjacent comment wording, that's scope creep.
- Final acceptance test for the whole plan (Task 12): `grep -rin "valeria" src/ scripts/ templates/ package.json .gitignore .env.example README.md docs/DESIGN.md docs/BLOCKING.md` returns zero results.

---

### Task 1: `src/config.ts`

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Produces: `config.roninRepo` (renamed from `config.valeriaRepo`, env var `RONIN_REPO` renamed from `VALERIA_REPO`, default `Oskr814/ronin`). `LABEL_MANAGED = 'ronin'`. `LABEL_STATES` values `ronin:ready`/`ronin:in-progress`/`ronin:blocked`/`ronin:done`. `localStatePath` default `.ronin-state.json`.
- Consumed by: Task 2 (`claim.ts` imports `LABEL_STATES`), Task 5 (`evidence.ts` reads `config.roninRepo`), Task 7 (`tick.ts` reads `LABEL_MANAGED`), and every module that already imports `config`/`LABEL_STATES`/`LABEL_MANAGED` unchanged in name otherwise.

No test file exists for `config.ts` — verified by `pnpm typecheck` after this task and the full suite at the end.

- [ ] **Step 1: Apply the renames**

Line 67 — `localStatePath` default:
```ts
  localStatePath: process.env.LOCAL_STATE_PATH ?? '.ronin-state.json',
```

Lines 68-71 — comment + field rename + env var + default:
```ts
  // ronin's own repo — e2e screenshot evidence is committed here (main),
  // shared across every repo.json entry, not split per product repo. See
  // docs/DESIGN.md §4.
  roninRepo: process.env.RONIN_REPO ?? 'Oskr814/ronin',
```

Lines 76-82 — labels:
```ts
export const LABEL_MANAGED = 'ronin';
export const LABEL_STATES = {
  ready: 'ronin:ready',
  'in-progress': 'ronin:in-progress',
  blocked: 'ronin:blocked',
  done: 'ronin:done',
} as const;
```

Line 85 — comment (unrelated `bugfix` label rationale, just the passing mention):
```ts
// bmedical's own pre-existing label ("Something isn't working") — reused as
// the bug-intake trigger instead of a new ronin:-prefixed label, see
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
```

- [ ] **Step 2: Typecheck (expected to fail — every consumer of the renamed fields hasn't been updated yet)**

Run: `pnpm typecheck`
Expected: FAIL, listing every file that still reads `config.valeriaRepo` (this is the punch list for Task 5).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "rebrand: rename valeria labels/paths/env vars to ronin in config.ts"
```

---

### Task 2: `src/claim.ts`

**Files:**
- Modify: `src/claim.ts`

**Interfaces:**
- Produces: `runnerLabel()` now returns `ronin:runner-<id>` instead of `valeria:runner-<id>`.
- Consumes: `LABEL_STATES` from Task 1 (already renamed, `claim.ts`'s import is unchanged by name).

No test file exists for `claim.ts`.

- [ ] **Step 1: Apply the rename**

Line 5:
```ts
const RUNNER_PREFIX = 'ronin:runner-';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors introduced by this file (claim.ts itself has no errors — `config.valeriaRepo` errors from Task 1 are unrelated to this file and still expected at this point).

- [ ] **Step 3: Commit**

```bash
git add src/claim.ts
git commit -m "rebrand: rename runner claim label prefix to ronin:runner- in claim.ts"
```

---

### Task 3: `src/stack.ts` + `src/stack.test.ts`

**Files:**
- Modify: `src/stack.ts`
- Modify: `src/stack.test.ts`

**Interfaces:**
- Produces: `sliceBranch`/`planBranch` now return `ronin/<issue>/...` branches. `SLICE_BRANCH_RE` and `prsForIssue`'s prefix match `ronin/...`.
- Consumed by: Task 4 (`worktree.ts`'s `branchFromWorktreeDirName` must reconstruct the same `ronin/...` shape), Task 6 (`github.ts`'s `listAllOpenRoninPrs` filters on the same `'ronin/'` prefix), Task 8 (`agent-task.ts` doesn't reference the branch string directly but relies on `stack.ts`/`worktree.ts` staying consistent).

- [ ] **Step 1: Apply the renames in `src/stack.ts`**

Lines 6-8:
```ts
export function sliceBranch(issueNumber: number, sliceIndex: number): string {
  return `ronin/${issueNumber}/slice-${sliceIndex + 1}`;
}
```

Lines 10-15:
```ts
// The 'plan' task's branch — never opens a PR (its job is to rewrite the
// tracking issue's body, see agent-task.ts), so it's the one ronin branch
// that never goes through the merge-time worktree cleanup in tick.ts.
export function planBranch(issueNumber: number): string {
  return `ronin/${issueNumber}/plan`;
}
```

Line 17:
```ts
const SLICE_BRANCH_RE = /^ronin\/\d+\/slice-(\d+)$/;
```

Lines 28-37:
```ts
// Slice branches are created as `ronin/<issue>/<slice-slug>` (see
// agent-task.ts's sliceBranch), so an issue's open PRs are found by branch
// prefix out of the single batched list (see github.ts's
// listAllOpenRoninPrs) instead of a separate per-issue fetch — see
// docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. Pure: no I/O,
// so it needs no mocking to test.
export function prsForIssue(allPrs: PullRequestStatus[], issueNumber: number): PullRequestStatus[] {
  const prefix = `ronin/${issueNumber}/`;
  return allPrs.filter((pr) => pr.headRefName.startsWith(prefix));
}
```

Lines 39-41:
```ts
// Ordena por índice de slice; descarta cualquier PR cuyo branch no matchee el
// patrón ronin/<issue>/slice-N (ej. el branch de la tarea 'plan') — no
// debería pasar en la práctica, pero mejor un PR ignorado que uno mal indexado.
```

- [ ] **Step 2: Apply the renames in `src/stack.test.ts`**

Replace every `'valeria/` literal with `'ronin/` — 11 occurrences at lines 7, 8, 12, 34, 35, 36, 48, 49, 62, 63, 69, 80 (some lines have more than one). Concretely:

```ts
    expect(sliceBranch(228, 0)).toBe('ronin/228/slice-1');
    expect(sliceIndexFromBranch('ronin/228/slice-1')).toBe(0);
```
```ts
    expect(sliceIndexFromBranch('ronin/228/plan')).toBeNull();
```
```ts
      pr('ronin/228/slice-2', { number: 230 }),
      pr('ronin/228/slice-1', { number: 229 }),
      pr('ronin/228/plan', { number: 1 }),
```
```ts
      pr('ronin/228/slice-2', { number: 230, reviewDecision: 'APPROVED' }),
      pr('ronin/228/slice-1', { number: 229, reviewDecision: '' }),
```
```ts
      pr('ronin/228/slice-1', { number: 229 }),
      pr('ronin/229/slice-1', { number: 300 }),
```
```ts
    const prs = [pr('ronin/2280/slice-1', { number: 300 })];
```
```ts
    expect(baseBranchFor(2, 228, 'origin/main')).toBe('ronin/228/slice-2');
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/stack.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "rebrand: rename branch prefix from valeria/ to ronin/ in stack.ts"
```

---

### Task 4: `src/worktree.ts` + `src/repo-context.ts` + their test files

**Files:**
- Modify: `src/worktree.ts`
- Modify: `src/repo-context.ts`
- Modify: `src/worktree.test.ts`
- Modify: `src/repo-context.test.ts`

**Interfaces:**
- Consumes: `ronin/<issue>/...` branch shape from Task 3 (must match exactly, `branchFromWorktreeDirName` reconstructs it).
- Produces: worktree directory names `ronin-<issue>-<rest>` (was `valeria-<issue>-<rest>`); `activeRepo().worktreeBasePath`'s default sibling-dir name becomes `ronin-worktrees` (was `valeria-worktrees`).

- [ ] **Step 1: Apply the renames in `src/worktree.ts`**

Line 108 (inside a comment citing real Docker container names — historical example, rename for consistency since it illustrates the *current* naming scheme, not a specific past incident):
```ts
// `ronin-228-slice-9-postgres-1` and `ronin-228-slice-10-postgres-1`
```

Line 133:
```ts
const WORKTREE_DIR_RE = /^ronin-(\d+)-(.+)$/;
```

Lines 137, 142:
```ts
// every ronin branch has exactly this shape (ronin/<issue>/<rest>, issue
// always numeric — see stack.ts's sliceBranch/planBranch), so there's no
// ambiguity to resolve. Exported for direct unit testing.
export function branchFromWorktreeDirName(name: string): string | null {
  const match = name.match(WORKTREE_DIR_RE);
  return match ? `ronin/${match[1]}/${match[2]}` : null;
}
```

Line 159:
```ts
    if (!branch) return []; // not a ronin worktree dir — leave it alone
```

- [ ] **Step 2: Apply the rename in `src/repo-context.ts`**

Line 36:
```ts
    worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(entry.productRepoPath, '..', 'ronin-worktrees'),
```

- [ ] **Step 3: Apply the renames in `src/worktree.test.ts`**

```ts
    expect(branchFromWorktreeDirName('ronin-228-slice-11')).toBe('ronin/228/slice-11');
```
```ts
    expect(branchFromWorktreeDirName('ronin-228-plan')).toBe('ronin/228/plan');
```
```ts
  it('returns null for a dir that is not a ronin worktree', () => {
```
```ts
    expect(branchesToSweep(['ronin-228-plan'], [])).toEqual(['ronin/228/plan']);
```
```ts
    const dirs = ['ronin-228-slice-1'];
    const allPrs = [pr('ronin/228/slice-1')];
```
```ts
    const dirs = ['ronin-228-slice-1', 'ronin-228-slice-2'];
    const allPrs = [pr('ronin/228/slice-2')]; // only slice-2 still open
    expect(branchesToSweep(dirs, allPrs)).toEqual(['ronin/228/slice-1']);
```
```ts
  it('ignores a directory that is not a ronin worktree', () => {
```
```ts
  await git(cwd, ['config', 'user.email', 'ronin@example.com']);
  await git(cwd, ['config', 'user.name', 'ronin']);
```
```ts
    base = await mkdtemp(join(tmpdir(), 'ronin-worktree-test-'));
```
```ts
    base = await mkdtemp(join(tmpdir(), 'ronin-ensure-worktree-test-'));
```
```ts
    const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
```
```ts
    const dirA = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
    const dirB = await withRepo(() => ensureWorktree('ronin/300/slice-2'));
```
```ts
    const dir = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
```
(second occurrence, in the "does not rewrite .env when reusing" test)
```ts
    const reused = await withRepo(() => ensureWorktree('ronin/300/slice-1'));
```

- [ ] **Step 4: Apply the rename in `src/repo-context.test.ts`**

```ts
      expect(activeRepo().worktreeBasePath).toBe('/tmp/a/ronin-worktrees');
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/worktree.test.ts src/repo-context.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worktree.ts src/repo-context.ts src/worktree.test.ts src/repo-context.test.ts
git commit -m "rebrand: rename worktree dir scheme from valeria- to ronin- prefix"
```

---

### Task 5: `src/evidence.ts` + `src/evidence.test.ts`

**Files:**
- Modify: `src/evidence.ts`
- Modify: `src/evidence.test.ts`

**Interfaces:**
- Consumes: `config.roninRepo` from Task 1.
- Produces: `EVIDENCE_CHECKOUT_DIR` now named `ronin-evidence-checkout`.

- [ ] **Step 1: Apply the renames in `src/evidence.ts`**

Lines 12-17:
```ts
// A dedicated checkout of ronin's own repo, always reset to main, used
// only for evidence commits — never the primary checkout, which a human
// (or Claude) might have on a feature branch mid-development. Sibling
// directory to ronin's own repo root (process.cwd() when `pnpm tick`
// runs, same assumption tick.ts already makes for templates/).
const EVIDENCE_CHECKOUT_DIR = join(process.cwd(), '..', 'ronin-evidence-checkout');
```

Line 25:
```ts
  await execFileAsync('git', ['clone', `git@github.com:${config.roninRepo}.git`, EVIDENCE_CHECKOUT_DIR]);
```

Lines 41-44:
```ts
// Copies whatever Playwright screenshots exist in the given bmedical
// worktree into ronin's own repo (evidence/<issue>/<pr>/...) and pushes
// to main. Returns the committed paths (relative to the ronin repo root,
// for building raw URLs) — [] if there was nothing to publish, which is
```

Line 83:
```ts
  log.info(`published ${committed.length} evidence screenshot(s) for PR #${prNumber} to ${config.roninRepo}`);
```

Line 93:
```ts
  return `https://github.com/${config.roninRepo}/blob/main/${path}`;
```

- [ ] **Step 2: Apply the renames in `src/evidence.test.ts`**

```ts
    roninRepo: 'Oskr814/ronin',
```
(field rename + value update to match the new default, in the `vi.mock('./config.js', ...)` block)

```ts
    expect(url).toBe('https://github.com/Oskr814/ronin/blob/main/evidence/228/229/1234567890/shot.png');
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/evidence.test.ts`
Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: `evidence.ts` no longer appears in the error list from Task 1's punch list.

- [ ] **Step 5: Commit**

```bash
git add src/evidence.ts src/evidence.test.ts
git commit -m "rebrand: rename evidence checkout dir and VALERIA_REPO to RONIN_REPO"
```

---

### Task 6: `src/github.ts`

**Files:**
- Modify: `src/github.ts`

**Interfaces:**
- Produces: `listAllOpenRoninPrs` (renamed from `listAllOpenValeriaPrs`) — consumed by Task 7 (`tick.ts`'s import).
- Filters PRs on branch prefix `'ronin/'` (was `'valeria/'`) — matches Task 3's renamed branch scheme.

No test file exists for `github.ts`.

- [ ] **Step 1: Apply the renames**

Line 28 (comment):
```ts
// directory's git remote or $GH_REPO — and the supervisor's cwd is ronin's
```

Line 71:
```ts
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-body-'));
```

Line 81:
```ts
const ATTEMPT_LABEL_RE = /^ronin:attempts-(\d+)$/;
```

Lines 106-109:
```ts
  await ensureLabel(`ronin:attempts-${next}`);
  // `gh issue edit`, not `gh pr edit` — see the note on setPrState below.
  const args = ['issue', 'edit', String(prNumber), '--add-label', `ronin:attempts-${next}`];
  if (current > 0) args.push('--remove-label', `ronin:attempts-${current}`);
```

Line 139:
```ts
  const dir = await mkdtemp(join(tmpdir(), 'ronin-issue-'));
```

Line 160 (comment):
```ts
// Swaps the current ronin:* state label for `next`. Only one state label is
```

Lines 243-254 (function + comment + filter):
```ts
// Single batched read behind tick()'s whole per-issue loop, replacing what
// used to be one `gh pr list` + one `gh pr view` per PR per issue — see
// docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. Filters
// client-side to ronin's own branches (`ronin/<issue>/slice-N` — see
// stack.ts's sliceBranch) since PRODUCT_REPO also carries ordinary human PRs
// under the same `--state open`.
export async function listAllOpenRoninPrs(): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_JSON_FIELDS]);
  const raw = (JSON.parse(stdout) as RawPr[]).filter((pr) => pr.headRefName.startsWith('ronin/'));
  if (raw.length === PR_LIST_LIMIT) {
    log.error(`listAllOpenRoninPrs: alcanzó el límite de ${PR_LIST_LIMIT} — puede haber PRs no traídos, subir PR_LIST_LIMIT`);
  }
  return raw.map(toPullRequestStatus);
}
```

Line 323:
```ts
const EVIDENCE_COMMENT_MARKER = '<!-- ronin:e2e-evidence -->';
```

Line 340 (comment):
```ts
  // Plain links, not `![]()` image embeds: ronin (where evidence lives) is
```

Line 355:
```ts
  const dir = await mkdtemp(join(tmpdir(), 'ronin-evidence-comment-'));
```

Line 399 (comment):
```ts
// state. Already-managed issues (label `ronin` present) or already in a
```

Line 468:
```ts
  const dir = await mkdtemp(join(tmpdir(), 'ronin-spec-pr-comment-'));
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: `github.ts` no longer errors on its own account. A new error appears for `tick.ts`'s import of the now-renamed `listAllOpenValeriaPrs` (that's Task 7's job to fix — expected at this point).

- [ ] **Step 3: Commit**

```bash
git add src/github.ts
git commit -m "rebrand: rename listAllOpenValeriaPrs and valeria:* labels/markers to ronin in github.ts"
```

---

### Task 7: `src/tick.ts` + `src/tick.test.ts`

**Files:**
- Modify: `src/tick.ts`
- Modify: `src/tick.test.ts`

**Interfaces:**
- Consumes: `listAllOpenRoninPrs` from Task 6, `LABEL_MANAGED`/`LABEL_STATES` from Task 1 (already renamed by import, no local change needed to the import statement itself beyond the function name).

- [ ] **Step 1: Apply the renames in `src/tick.ts`**

Line 14 (import list):
```ts
  listAllOpenRoninPrs,
```

Line 117 (comment):
```ts
      // Without this, the issue stays labeled ronin:ready forever and
```

Line 173 (comment):
```ts
      // still leaves the issue ronin-managed (and therefore reachable via
```

Line 216 (comment):
```ts
// §5). 'blocked': the issue was just set to ronin:blocked by
```

Line 275 (comment):
```ts
// triggered blockOnAttemptLimit (issue set to ronin:blocked) and the caller
```

Line 309 (comment):
```ts
      // ronin's own main, which also takes code commits — see
```

Line 376 (comment):
```ts
      // ronin:in-progress forever. Also shaves a tick off `done` for
```

Line 475 (comment):
```ts
    // camino y dejó el issue con el label `ronin` puesto pero sin ninguna
```

Lines 584 and 586 (usage):
```ts
      allPrs = await listAllOpenRoninPrs();
    } catch (error) {
      log.info(`tick: listAllOpenRoninPrs falló, reintentando en el próximo tick: ${(error as Error).message}`);
```

- [ ] **Step 2: Apply the renames in `src/tick.test.ts`**

Line 19 (mock):
```ts
  LABEL_MANAGED: 'ronin',
```

`headRefName`/`baseRefName` fixtures — every occurrence of `'valeria/228/slice-1'`/`'valeria/228/slice-2'` becomes `'ronin/228/slice-1'`/`'ronin/228/slice-2'` (lines 111, 112, 165, 177, 185, 208, 226, 250, 273, 299, 319, 358, 376 — 14 occurrences total, all the same two literal strings repeated across different test cases). Example of the pattern each one follows:
```ts
    headRefName: 'ronin/228/slice-1',
```
and where both appear together:
```ts
    headRefName: 'ronin/228/slice-2',
    baseRefName: 'ronin/228/slice-1',
```
and the one assertion:
```ts
    expect(removeWorktree).toHaveBeenCalledWith('ronin/228/slice-1');
```

Mention body fixtures — every `'@valeria-agent ...'` becomes `'@ronin ...'` (lines 254, 262, 277, 303, 323 — 5 occurrences):
```ts
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }]);
```
```ts
      mentions: [{ id: 1, kind: 'issue', body: '@ronin fijate esto', reactionsEyes: 0 }],
```
```ts
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin corré los e2e', reactionsEyes: 0 }]);
```
(appears twice, lines 277 and 323 — identical replacement)
```ts
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin fijate esta línea', reactionsEyes: 0 }]);
```

Line 391 (test description):
```ts
  it('labels, seeds, and starts a bug issue not yet ronin-managed', async () => {
```

Line 396 (assertion):
```ts
    expect(addIssueLabel).toHaveBeenCalledWith(500, 'ronin');
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/tick.test.ts`
Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: `tick.ts` no longer errors.

- [ ] **Step 5: Commit**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "rebrand: rename valeria labels/branches/mentions to ronin in tick.ts"
```

---

### Task 8: `src/agent-task.ts` + `src/agent-task.test.ts`

**Files:**
- Modify: `src/agent-task.ts`
- Modify: `src/agent-task.test.ts`

**Interfaces:**
- Produces: every task-type prompt now opens with `"You are ronin..."` instead of `"You are ValerIA..."` — this is the literal text sent to the headless `claude -p` invocation as the agent's self-identification. No signature changes.

- [ ] **Step 1: Apply the renames in `src/agent-task.ts`**

Seven occurrences, each the start of a template-literal prompt string, at lines 41, 67, 87, 104, 118, 132, 157. Each follows the same substitution — replace the leading `You are ValerIA` with `You are ronin`, keeping everything after it byte-identical:

Lines 41 and 67 (identical string, two call sites):
```ts
          `You are ronin, an autonomous agent working on tracking issue #${task.issueNumber} in ${repoUrl()}.`,
```

Line 87:
```ts
          `You are ronin, an autonomous agent working on issue #${task.issueNumber} in ${repoUrl()}, labeled "bugfix".`,
```

Line 104:
```ts
          `You are ronin. PR #${task.prNumber} (tracking issue #${task.issueNumber}) has unresolved review comments.`,
```

Line 118:
```ts
          `You are ronin. CI/e2e checks (Playwright) are failing on PR #${task.prNumber} (tracking issue #${task.issueNumber}).`,
```

Line 132:
```ts
          `You are ronin. PR #${task.prNumber} (tracking issue #${task.issueNumber}) is behind \`${config.worktreeBaseRef}\` and couldn't be rebased mechanically — it hit a real conflict.`,
```

Line 157:
```ts
          `You are ronin. A human left the following comment(s) on PR #${task.prNumber} (tracking issue #${task.issueNumber}), mentioning you and asking for a review:`,
```

- [ ] **Step 2: Apply the renames in `src/agent-task.test.ts`**

Line 43:
```ts
  getPullRequestStatus.mockResolvedValue({ headRefName: 'ronin/228/slice-1' });
```

Line 52:
```ts
    mentions: [{ id: 1, kind: 'issue' as const, body: '@ronin corré los e2e y dejá evidencia', reactionsEyes: 0 }],
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent-task.test.ts`
Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: `agent-task.ts` no longer errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent-task.ts src/agent-task.test.ts
git commit -m "rebrand: agent self-identifies as ronin instead of ValerIA in task prompts"
```

---

### Task 9: `src/notifier.ts` + `src/notifier.test.ts`

**Files:**
- Modify: `src/notifier.ts`
- Modify: `src/notifier.test.ts`

**Interfaces:**
- Produces: blocker email subject `[ronin] Bloqueo: ...` instead of `[ValerIA] Bloqueo: ...`. No signature changes.

- [ ] **Step 1: Apply the renames in `src/notifier.ts`**

Line 24 (comment):
```ts
// valeria:blocked label) still runs even if Gmail itself is unreachable.
```
becomes:
```ts
// ronin:blocked label) still runs even if Gmail itself is unreachable.
```

Line 50:
```ts
      subject: `[ronin] Bloqueo: ${notification.reason}`,
```

- [ ] **Step 2: Apply the rename in `src/notifier.test.ts`**

Line 5:
```ts
    gmailUser: 'ronin@example.com',
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/notifier.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/notifier.ts src/notifier.test.ts
git commit -m "rebrand: rename blocker email subject prefix to [ronin]"
```

---

### Task 10: Config files, template, and remaining test fixture strings

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `templates/tracking-issue.md`
- Modify: `src/repos.test.ts`
- Modify: `src/local-state.test.ts`

**Interfaces:** None — no exported symbols, only literal string content.

- [ ] **Step 1: `package.json`**

Line 2:
```json
  "name": "ronin",
```

- [ ] **Step 2: `.gitignore`**

Line 4:
```
.ronin-state.json*
```

- [ ] **Step 3: `.env.example`**

Line 58 (comment):
```
# ronin:runner-<esto> en el PR del spec) como para el claim de issues entre
```

Line 64:
```
LOCAL_STATE_PATH=.ronin-state.json
```

Line 68:
```
RONIN_REPO=Oskr814/ronin
```
(also rename the surrounding comment lines above it from "Repo de ValerIA" to "Repo de ronin" and `VALERIA_REPO` to `RONIN_REPO` wherever the var name is mentioned in that comment block — read the block first since exact line numbers may have shifted from earlier edits in this same file during the multi-repo PR; the comment reads "Repo de ValerIA — la evidencia..." above the `VALERIA_REPO=` line, both need the rename)

- [ ] **Step 4: `templates/tracking-issue.md`**

Line 30:
```
     review comment) at the same moment the `ronin:blocked` label is
```

- [ ] **Step 5: `src/repos.test.ts`**

Line 16:
```ts
  dir = await mkdtemp(join(tmpdir(), 'ronin-repos-test-'));
```

- [ ] **Step 6: `src/local-state.test.ts`**

Line 17:
```ts
  dir = await mkdtemp(join(tmpdir(), 'ronin-local-state-test-'));
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: PASS, 101/101 (no count change — this task only touches fixture strings and non-code files)

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore .env.example templates/tracking-issue.md src/repos.test.ts src/local-state.test.ts
git commit -m "rebrand: rename package name, gitignore pattern, and remaining test fixtures to ronin"
```

---

### Task 11: Docs — `README.md`, `docs/DESIGN.md`, `docs/BLOCKING.md`

**Files:**
- Modify: `README.md`
- Modify: `docs/DESIGN.md`
- Modify: `docs/BLOCKING.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: `README.md` title and etymology**

Replace the current title block:
```markdown
# ValerIA

> *Del latín "valere" — estar sano, ser fuerte.*
```
with:
```markdown
# ronin

> *Del japonés 浪人 (rōnin) — samurai sin señor, que actúa por su propio juicio.*
```

- [ ] **Step 2: `README.md` remaining mentions**

Line 15:
```markdown
- Trocear el trabajo en slices pequeños y revisables (PRs apilados), una vez que un humano le asigna un spec (PR + label `ronin:runner-<usuario>`, ver §1 del diseño)
```

Line 28:
```markdown
6. `pnpm init-labels` — crea en cada repo de `repos.json` los labels `ronin*` que usa el pipeline, incluida tu label de asignación `ronin:runner-<RUNNER_ID>`. Sin esto no vas a poder seleccionarla desde la UI de GitHub al asignarte un spec. Requiere `jq` instalado en el host (el script itera `repos.json` con él).
```

Line 36:
```markdown
2. Poné la label `ronin:runner-<RUNNER_ID>` en ese PR — así lo asignás a tu runner.
```

Line 44:
```markdown
No hace falta ningún setup manual adicional para esto: la cuenta `ronin` invitada como colaboradora en el §Setup ya es la misma identidad que abre los PRs y la que se @menciona — a diferencia del diseño anterior (GitHub App + usuario `ronin-agent` separado), no hay una segunda cuenta que crear.
```

(This line describes a *historical* prior design — its own text already frames it as "el diseño anterior". Use the generic rewrite above, not the old design's literal historical name `valeria-agent`: this file is living documentation, not a dated record, and the plan's acceptance grep in Task 12 requires zero `valeria` hits here.)

- [ ] **Step 3: `docs/DESIGN.md` — non-historical sections**

Line 28:
```markdown
1. El humano escribe el spec, abre el PR **en draft**, y le pone la label `ronin:runner-<su-usuario-de-github>` (ej. `ronin:runner-oskr814`) — así asigna qué runner lo va a procesar. Mientras está en draft, el agente lo ignora por completo: el humano puede seguir iterando el contenido sin que nada dispare.
```

Line 35:
```markdown
con la label propia de `bugfix` (ya existente en el repo) y `ronin:runner-<id>`, se
```

Lines 61-62:
```markdown
- `ronin` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `ronin:ready | ronin:in-progress | ronin:blocked | ronin:done` — estado actual, mutuamente excluyente, la swap-ea el agente. Espejo 1:1 del `status` del frontmatter del spec.
```

Line 74:
```markdown
1. Escanea specs asignados vía PR + label (`ronin:runner-<id>`, ver §1) → mergea el spec, crea el issue, dispara una sesión `claude -p` en un worktree nuevo para plan + primera slice.
```

Line 80:
```markdown
**Un tick a la vez por host**: como un tick puede tardar (una invocación de `claude -p` puede llegar a `AGENT_TASK_TIMEOUT_MINUTES`), el wrapper que genera `setup-cron.sh` usa `flock` para que un disparo de cron mientras el anterior sigue corriendo se salte en vez de arrancar en paralelo — evita que dos ticks concurrentes en el mismo host pisen `.ronin-state.json` a la vez. Esto es independiente del claim entre runners distintos (§9), que protege contra *otro host*, no contra el mismo proceso solapado consigo mismo.
```

Line 84:
```markdown
Convención de branches: `ronin/<issue>/<slice-slug>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.
```

Line 101:
```markdown
- `evidence.ts` — publica screenshots de Playwright en `RONIN_REPO` (no en `PRODUCT_REPO`) y arma sus URLs raw — ver §4
```

Line 102 (also fixes a pre-existing staleness from the PAT PR while touching this line — the App/installation-token description is no longer accurate, since `claude-runner.ts` now forwards the static PAT):
```markdown
- `claude-runner.ts` — invoca `claude -p` con `--permission-mode bypassPermissions`, reenviando el PAT de la cuenta `ronin` como `GH_TOKEN` al proceso hijo (así los `gh` que el propio Claude headless corra también quedan a nombre de esa cuenta)
```

Line 104:
```markdown
- `claim.ts` — lock por label (`ronin:runner-<runner-id>`) + cache local (`.ronin-state.json`) para que dos supervisores no procesen el mismo issue — ver §9
```

Line 115:
```markdown
2. El supervisor (`src/evidence.ts`) lee esas capturas directo del worktree en disco, las copia a un checkout dedicado de **ronin** (`RONIN_REPO`, siempre en `main`, nunca el checkout que un humano pueda tener en otra branch) bajo `evidence/<issue>/<pr>/<timestamp>/` — la subcarpeta por timestamp evita que dos publicaciones para el mismo PR se pisen —, commitea y pushea.
```

Line 116:
```markdown
3. Postea un comentario en el PR de bmedical (`postEvidenceComment` — no edita, evita la complejidad de resolver el id REST de un comentario desde el `--json` de `gh`) con un link a cada imagen (`github.com/<RONIN_REPO>/blob/main/...`, la vista blob normal de GitHub, no `raw.githubusercontent.com` — ese dominio no comparte la sesión del browser con github.com y no puede autenticar contra un repo privado).
```

Line 120:
```markdown
Por qué en ronin y no en bmedical: el historial del producto no debería acumular binarios de cada PR. El costo es un checkout extra (`ronin-evidence-checkout/`, sibling del repo) que el supervisor mantiene sincronizado a `main` en cada publicación — y como `main` de ronin también tiene código revisado del propio supervisor, esto mezcla commits automáticos de datos con historial de código (decisión consciente, más simple que una branch separada, pero vale reconsiderar si el volumen crece mucho).
```

Line 162:
```markdown
Misma identidad que la asignación de specs (§1): `RUNNER_ID` (el usuario de GitHub, ej. `oskr814`, requerido — no hay default de hostname porque no significaría nada para un humano poniendo la label a mano) y el mismo label `ronin:runner-<runner-id>`, reutilizado como lock automático sobre issues además de como asignación manual sobre specs. La diferencia es quién lo escribe: en un spec PR lo pone un humano a mano; en un issue de tracking lo pone el propio `claim.ts` al procesar.
```

Line 164:
```markdown
- **Estado local** (`.ronin-state.json`, gitignored, no compartido entre runners): cache de qué issues ya reclamó este runner. Si un issue ya está ahí, ni siquiera se consulta GitHub — se procesa directo. Es solo una optimización, no la fuente de verdad: si el archivo se pierde o es la primera corrida, se re-deriva todo desde las labels reales.
```

Line 165:
```markdown
- Cuando el estado local no tiene el issue: si ya hay un `ronin:runner-*` de *otro* runner, se salta. Si no hay ninguno, agrega el propio y **relee** las labels — dos runners pueden pasar el chequeo y agregar su label en el mismo instante (`--add-label` no es compare-and-swap), así que el desempate es determinista: gana el `runner-id` alfabéticamente menor, sin esperar nada. El que pierde saca su propia label.
```

Line 178:
```markdown
- [x] Estado persistente entre ticks: índice de slice actual (`src/checklist.ts`, parseado del propio checklist del issue) y contador de reintentos por PR (`ronin:attempts-N`, labels en `src/github.ts`) — ver §3.1
```

Line 182:
```markdown
- [x] Evidencia visual de e2e en el PR — `src/evidence.ts` publica screenshots a `RONIN_REPO` y las embebe en un comentario vía URL raw, ver §4
```

Line 200:
```markdown
- `discoverNewSpecs` nunca transicionaba el issue de `ronin:ready` a `ronin:in-progress` — el issue hubiera quedado invisible para el supervisor en todo tick posterior.
```

Line 201:
```markdown
- **Hallazgo de contención real**: durante `implement-slice`, el prompt le decía al agente "leé el checklist del issue completo" — eso lo exponía a las instrucciones para *otras* tareas embebidas en `templates/tracking-issue.md` (la sección de Bloqueo), y el agente se auto-aplicó la label `ronin:blocked` por su cuenta, sin que se lo pidiéramos y sin llenar la sección que la propia plantilla exige. Arreglado pasando el título de la slice directo en el prompt en vez de decirle que lea el issue entero, y agregando una instrucción explícita en los cuatro prompts de que la issue/labels son responsabilidad exclusiva del supervisor. Esto no es una garantía — con `bypassPermissions` el agente puede en principio ejecutar cualquier `gh`/`git` que decida — pero reduce la superficie de lo que razonablemente terminaría leyendo y actuando por su cuenta.
```

**Skip entirely (out of scope, dated historical log):** every line inside "### 10. Primer dry run (2026-07-28)" — this includes the line currently at 195 (`ValerIA[bot]`/`app/valeria-agent`) and everything else in that section. Do not touch it.

- [ ] **Step 4: `docs/BLOCKING.md`**

Line 28:
```markdown
El agente aplica la label `ronin:blocked` **en el mismo momento** en que completa la sección "Bloqueo" del issue (ver `templates/tracking-issue.md`) — nunca una sin la otra, para que el estado en GitHub y el email siempre cuenten la misma historia.
```

- [ ] **Step 5: Read both edited files once end-to-end**

Confirm no line was missed and no cross-reference (e.g. a "ver §4" pointer) now points at a renumbered/nonexistent section — this task doesn't change section numbers, only inline text, so this should be a quick skim, not a restructure.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/DESIGN.md docs/BLOCKING.md
git commit -m "rebrand: update README, DESIGN, and BLOCKING docs to ronin (dated dry-run log untouched)"
```

---

### Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS, 101/101 (same count as before this plan — no tests added or removed, only renamed content)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS, `dist/` regenerated with no errors

- [ ] **Step 4: The plan's acceptance grep**

Run: `grep -rin "valeria" src/ scripts/ templates/ package.json .gitignore .env.example README.md docs/DESIGN.md docs/BLOCKING.md`
Expected: no output. (If `docs/DESIGN.md`'s §10 dry-run log is the only remaining hit, that's correct per this plan's Global Constraints — verify by inspection that any surviving hit is inside that one section and nowhere else.)

- [ ] **Step 5: Confirm historical specs/plans were never touched**

Run: `git diff --stat main -- docs/superpowers/specs/ docs/superpowers/plans/`
Expected: no output (zero changes to any file under those two directories across the whole plan).
