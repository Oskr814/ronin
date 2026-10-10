# Exhaustive, incremental and verifiable external review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ronin's automatic review of external PRs converge — find everything in the first pass, focus re-reviews on what changed, stop fixes from seeding the next round — and make every finding quick to accept or dismiss.

**Architecture:** The `external-review` agent stops writing to GitHub. It writes a `findings.json` (fixed contract) to a ronin-owned directory; the supervisor validates it, applies the convergence rules in code, renders every comment from a fixed template, and publishes. The review criteria move out of the TypeScript prompt into `prompts/external-review-criteria.md`, read at runtime and shared with the fix tasks' self-review.

**Tech Stack:** TypeScript, Vitest, `gh` CLI (REST + GraphQL via `gh api`), `git`, `tsx` for scripts.

**Spec:** `docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md`

## Stages

Each stage is independently shippable and leaves `pnpm test`, `pnpm typecheck` and `pnpm build` green.

| Stage | Delivers | Detail level here |
|---|---|---|
| **1** | Criteria file, `findings.json` contract, supervisor-side publishing, new comment format, exhaustive first-pass prompt, dry-run script | Full (Tasks 1–9) |
| **2** | Incremental mode: last reviewed SHA from GitHub, content-based scope, scope rules, delta subagent, full thread history, dedupe | Outline (Tasks 10–14) — expand before starting |
| **3** | Self-review in `fix-review`, `fix-comments`, `fix-comments-external`, `review-request` | Outline (Task 15) |
| **4** | Test-based verification for 🐞 🔴/🟠 on non-fork PRs | Outline (Task 16) |

## Global Constraints

- The `external-review` agent never writes to GitHub after Stage 1. Every write (review, thread resolution, mention reply) goes through `github.ts` from the supervisor.
- `postReview` hardcodes `event: COMMENT`. No code path can send `APPROVE` or `REQUEST_CHANGES`.
- The criteria file is read only from ronin's own checkout (`process.cwd()`), never from the product repo or the PR worktree.
- Everything the agent writes into `findings.json` derives from untrusted PR content: the supervisor neutralizes `@handle` mentions before publishing, and caps every field's length.
- A missing or unparseable `findings.json` fails the task exactly like a `claude -p` failure does today (status `error`, no SHA recorded, retried next tick). One invalid finding is dropped with a log line and never fails the rest.
- Per-candidate isolation in `tick.ts` stays as it is: nothing in this flow may reach `tick()`'s outer catch.
- `github.ts` keeps its "no test file beyond pure logic" convention (see the header of `src/github.test.ts`); new `gh`-shelling functions are covered through the consumers' mocks.

---

## Stage 1

### Task 1: Criteria file and loader

**Files:**
- Create: `prompts/external-review-criteria.md`
- Create: `src/review-criteria.ts`, `src/review-criteria.test.ts`

**Interfaces:**
- Produces: `loadReviewCriteria(): Promise<{ text: string; blobHash: string }>` — consumed by Task 6 (prompt) and Task 3 (marker).

- [ ] **Step 1: Write the criteria file**

Migrate the dimensions currently inline in `src/agent-task.ts` (`external-review` case) and add the sections the spec defines. Structure:

```markdown
# Criterio de review externa

## Dimensiones
### Correctitud y bugs
### Concurrencia y transacciones
### Seguridad
### Cobertura de tests
### Duplicación y code smells

## Tipos
- bug (🐞) — escenario de falla concreto.
- decision (❓) — obligatorio si un test, comentario o el spec sugieren que el comportamiento es intencional. Redactar como pregunta sí/no.
- improvement (🧹) — smell, duplicación, estilo.

## Severidad
(definición + un ejemplo por nivel)
### Pisos
- Bypass de una regla de negocio (crédito, permisos, precios) → critical.
- Artefacto generado roto (XML, build) o cambio de contrato de API (p. ej. 400 → 500) → al menos important.

## Clases sistémicas (barrer todas las instancias, reportar un único hallazgo)
- Check-then-act / carreras.
- Validación que se puede saltear por algún camino.
- Inputs no revalidados tras tomar un lock: enumerar todos.
- Chequeo de autorización faltante en un endpoint hermano.

## No marcar
- No sugerir constantes compartidas dentro de migraciones: son snapshots inmutables y usan literales.
```

Write it in Spanish (it is read by humans tuning it) — the prompt that wraps it stays in English like every other prompt in `agent-task.ts`.

- [ ] **Step 2: Write failing tests for the loader**

`src/review-criteria.test.ts`, mocking `node:fs/promises`:

- returns the file's text read from `join(process.cwd(), 'prompts/external-review-criteria.md')`;
- `blobHash` equals git's blob hash: for content `"hello\n"` it must be `ce013625030ba8dba906f756967f9e9ca394464a` (`echo hello | git hash-object --stdin`);
- rejects when the file is missing (no fallback).

- [ ] **Step 3: Implement**

```ts
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const REVIEW_CRITERIA_PATH = 'prompts/external-review-criteria.md';

// Same blob hash `git hash-object` computes — lets `git log --find-object`
// locate the exact criteria version a finding was produced with (see the
// ronin:finding marker in review-render.ts).
function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export async function loadReviewCriteria(): Promise<{ text: string; blobHash: string }> {
  const content = await readFile(join(process.cwd(), REVIEW_CRITERIA_PATH));
  return { text: content.toString('utf8'), blobHash: gitBlobHash(content) };
}
```

Read as a `Buffer` (not `'utf8'`) so the byte length in the blob header is right for non-ASCII content.

- [ ] **Step 4: `pnpm test src/review-criteria.test.ts` passes. Commit.**

---

### Task 2: `findings.json` contract and validation

**Files:**
- Create: `src/review-output.ts`, `src/review-output.test.ts`

**Interfaces:**
- Produces: types `ReviewFinding`, `ExternalReviewOutput`, and `parseReviewOutput(raw: string, ctx: { mentionIds: Set<number>; openThreadIds: Set<string> }): { output: ExternalReviewOutput; dropped: Array<{ index: number; reason: string }> }` — consumed by Tasks 5, 7.

- [ ] **Step 1: Types** — exactly the contract in spec §Diseño 4, with `verification.status` limited to `'reasoned'` handling in Stage 1 (the type already allows `'verified'`; Stage 4 starts producing it).

- [ ] **Step 2: Failing tests**

- top-level JSON invalid or not an object → throws (task-level failure);
- missing `findings` / `resolveThreads` / `mentionReplies` arrays → treated as empty, not an error;
- a finding with an unknown `type`/`severity` → dropped with reason, others kept;
- `scenario` missing on `bug`/`decision` → dropped; missing on `improvement` → kept;
- over-long fields truncated with `…` at the limits (title 120, scenario 400, impact 200, detail 1500, affectedCode 1200);
- `line < 1`, non-integer, or `startLine > line` → dropped;
- `suggestion.kind === 'replace'` with `line - startLine > 10` → degraded to `{ kind: 'text' }` with the code in a fenced block, finding kept;
- `resolveThreads` entries whose `threadId` is not in `openThreadIds` → dropped (the agent can only resolve the bot's own open threads);
- `mentionReplies` entries whose `commentId` is not in `mentionIds` → dropped.

- [ ] **Step 3: Implement** `parseReviewOutput` by hand (no new dependency): a small `asString/asEnum/asInt` helper set, per-finding try/catch collecting `dropped`.

- [ ] **Step 4: Tests pass. Commit.**

---

### Task 3: Rendering

**Files:**
- Create: `src/review-render.ts`, `src/review-render.test.ts`

**Interfaces:**
- Consumes: `ReviewFinding` (Task 2), `blobHash` (Task 1).
- Produces: `renderFindingComment(f, ctx)`, `renderAgentPrompt(f)`, `renderReviewSummary(findings, ctx)`, `renderClosing(state)`, `neutralizeMentions(text)` — consumed by Task 7.
- `ctx`: `{ repo: string; headSha: string; criteriaHash: string; mode: 'full' | 'incremental' }`; `scope` is `'changed'` for every finding in Stage 1.

- [ ] **Step 1: Failing tests** (inline expected strings, not snapshot files — matches the rest of the repo):

- marker is the first line, with every field (`v=2 type= severity= category= verification= mode= scope= criteria=`); `category` is slugified (spaces → `-`, no `>`/`--`) so it cannot break the HTML comment;
- the title line is `### <typeEmoji><severityEmoji> <title>` with the emoji derived from the fields (🐞/❓/🧹 × 🔴/🟠/🟡) — never taken from the model;
- visible block: **Escenario**, **Impacto**, **Evidencia** (each item a link `https://github.com/<repo>/blob/<headSha>/<path>#L<line>` + note), **Verificación** (`razonado` + reason when present). For `decision`, an extra line: `**Si es intencional:** resolvé el hilo.`;
- `suggestion.kind === 'replace'` → a ```` ```suggestion ```` block; `kind === 'text'` → plain paragraph **Corrección:**;
- `extraLocations` rendered as **También en:** links (systemic findings);
- `detail` inside `<details><summary>Detalle</summary>`; omitted when absent;
- agent prompt: last block, `<details><summary>Prompt para agentes de IA 🤖</summary>` + a ````` ````markdown ````` fence containing location, type line (decision → "preguntá antes de cambiar"), scenario, `affectedCode` in an inner fence, proposed fix, and the closing "Antes de cambiar: confirmá que el escenario es posible leyendo el código. Si no lo es, no cambies nada y explicá por qué.";
- summary: a table `| | Severidad | Hallazgo |` with one row per finding linking to its anchor when inline, plus a section **Fuera del diff** for findings that could not be anchored (full rendered comment inline in the summary), plus one combined agent prompt covering every finding;
- `renderClosing`: `'lgtm'` → `LGTM 🚀`; `'confirmed'` → `✅ Ajustes confirmados, no quedan observaciones pendientes.`; `{ open: n, links }` → `Sin observaciones nuevas; quedan N abiertas:` + links;
- `neutralizeMentions('ping @someone and @org/team')` inserts a zero-width joiner after `@` (`@‍someone`), leaving emails (`a@b.com`) untouched;
- the summary body never exceeds 60 000 chars: when over, the combined prompt is dropped first, then per-finding detail.

- [ ] **Step 2: Implement.** Every string field coming from the model goes through `neutralizeMentions` inside the renderer, so callers cannot forget it.

- [ ] **Step 3: Tests pass. Commit.**

---

### Task 4: GitHub write primitives

**Files:**
- Modify: `src/github.ts`

**Interfaces:**
- Produces: `postReview(prNumber, { commitId, body, comments })`, `resolveReviewThread(threadId)`, `ExternalPr.baseRefName` — consumed by Tasks 5, 7.

- [ ] **Step 1: `ExternalPr.baseRefName`** — add `baseRefName` to the `--json` field list in `listAllOpenExternalPrs`, to `RawExternalPr`, and to the mapped result. Update the `extPr()` fixture in `src/external-review.test.ts` with a default `baseRefName: 'main'`.

- [ ] **Step 2: `postReview`**

```ts
export interface ReviewCommentInput {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

// A review with inline comments needs a JSON array body, which `gh api -f`
// can't express — so the payload goes through --input from a temp file.
// event is hardcoded: a bot review never gates the merge (spec 2026-08-20,
// "Nunca APPROVE ni REQUEST_CHANGES"), and there is deliberately no
// parameter that could change it.
export async function postReview(
  prNumber: number,
  review: { commitId: string; body: string; comments: ReviewCommentInput[] },
): Promise<void> {
  const payload = {
    commit_id: review.commitId,
    event: 'COMMENT',
    body: review.body,
    comments: review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      ...(c.startLine != null && c.startLine < c.line ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
      body: c.body,
    })),
  };
  const dir = await mkdtemp(join(tmpdir(), 'ronin-review-'));
  const file = join(dir, 'review.json');
  try {
    await writeFile(file, JSON.stringify(payload));
    await ghApi(['api', '--method', 'POST', `repos/${activeRepo().productRepo}/pulls/${prNumber}/reviews`, '--input', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: `resolveReviewThread(threadId)`** — `gh api graphql` with the same mutation the prompt uses today.

- [ ] **Step 4: `pnpm typecheck` passes. Commit.** (No direct tests — convention; covered via Task 7's mocks.)

---

### Task 5: Commentable lines and placement

**Files:**
- Create: `src/review-scope.ts`, `src/review-scope.test.ts`

**Interfaces:**
- Consumes: `ReviewFinding` (Task 2).
- Produces: `parseCommentableLines(unifiedDiff: string): Map<string, Set<number>>`, `commentableLines(headSha, baseRef): Promise<Map<...>>`, `placeFindings(findings, commentable): { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] }` — consumed by Task 7. Stage 2 adds the content-based classification to this same module.

- [ ] **Step 1: Failing tests for `parseCommentableLines`** (pure, fixture diffs as strings):

- new-side line numbers of every `+` and context line inside each hunk are commentable; `-` lines are not;
- multiple hunks and multiple files; renamed file uses the `+++ b/<path>` name;
- deleted file (`+++ /dev/null`) contributes nothing; binary file contributes nothing.

- [ ] **Step 2: Failing tests for `placeFindings`**:

- anchor line in the set → inline; otherwise → `outOfDiff`;
- multi-line: inline only when every line in `startLine..line` is commentable; otherwise the finding stays inline on `line` with `startLine` dropped and a `replace` suggestion degraded to text (a suggestion block must replace exactly the anchored range).

- [ ] **Step 3: Implement.** `commentableLines` runs, in `activeRepo().productRepoPath`:
`git merge-base origin/<baseRefName> <headSha>` then `git diff -U3 <mergeBase> <headSha>` (default context matches what GitHub renders), and feeds stdout to `parseCommentableLines`. `ensureExternalReviewWorktree` already fetched `pull/<n>/head`; additionally `git fetch origin <baseRefName>` before computing the merge base.

- [ ] **Step 4: Tests pass. Commit.**

---

### Task 6: New `external-review` prompt

**Files:**
- Modify: `src/agent-task.ts` (`AgentTask` union, `external-review` case), `src/agent-task.test.ts`

**Interfaces:**
- Consumes: `loadReviewCriteria` (Task 1).
- Produces: the task variant gains `outputPath: string` and `criteriaText: string`. The supervisor (Task 7) loads the criteria once and passes the text in, so the prompt and the marker always use the same version.

- [ ] **Step 1: Update tests first** — replace the assertions tied to the old flow:

- the prompt contains the criteria text verbatim and the `outputPath`;
- it contains the `findings.json` contract (field names and enums);
- it forbids GitHub writes explicitly: no `gh pr comment`, no `gh api …/reviews`, no `gh pr review`, no GraphQL mutations — reading (`gh pr diff`, `gh pr view`) stays allowed;
- it instructs one subagent per dimension listed in the criteria, each subagent prompt repeating the untrusted-content warning, then consolidation (dedupe + verify each finding against the code);
- it requires enumerating every file in the diff and not finishing before covering all of them;
- it requires systemic findings (one finding with `extraLocations`) for the classes listed in the criteria;
- it lists open bot threads (fenced, as today) and asks for `resolveThreads` entries only when a code change addresses them;
- it lists mentions (fenced, as today) and asks for one `mentionReplies` entry per mention id;
- it keeps: untrusted-content warning, "never write @handle", checkout pinned at `headSha`;
- it no longer contains the old comment template, `commit_id` instructions, or LGTM instructions (the supervisor owns all of that now);
- every existing worktree/cleanup/`.claude` stripping test still passes unchanged.

- [ ] **Step 2: Implement** — rewrite the `external-review` case. Prompt outline (English, like the rest):

1. Role + untrusted-content warning (kept verbatim).
2. "Review criteria (trusted, from the supervisor):" + `criteriaText`.
3. Read the diff (`gh pr diff <n>`) against the full repo at `headSha`; list every changed file.
4. Launch one subagent per dimension; pass each the diff, the criteria section for its dimension, and the untrusted-content warning. Consolidate.
5. Systemic findings rule.
6. Severity floors and type rules come from the criteria; `decision` mandatory when there is evidence of intent — cite that evidence.
7. Open threads → `resolveThreads`. Mentions → `mentionReplies`.
8. Output: write exactly one JSON object to `<outputPath>` matching the contract (inline the TypeScript interface). Nothing else is published by you.
9. Never write to GitHub.

- [ ] **Step 3: Tests pass. Commit.**

---

### Task 7: Supervisor-side publishing

**Files:**
- Create: `src/review-publish.ts`, `src/review-publish.test.ts`
- Modify: `src/tick.ts` (`processExternalReviewCandidate`), `src/tick.test.ts`, `src/external-review.ts` (`ReviewCandidate.baseRefName`)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `runExternalReview(candidate, opts: { dryRun?: { outFile: string } }): Promise<void>` — the whole flow, used by `tick.ts` and the dry-run script (Task 8).

- [ ] **Step 1: Failing tests for `runExternalReview`** (mock `agent-task.js`, `github.js`, `review-scope.js`, `review-criteria.js`, `node:fs/promises`):

- output path is `join(activeRepo().worktreeBasePath, 'external-review-out', `${pr}-${headSha}.json`)`, created before the run and removed after (success or failure);
- `runAgentTask` gets `criteriaText` and `outputPath`;
- missing output file → throws (so the caller marks status `error` and skips the SHA);
- resolves each `resolveThreads` entry via `resolveReviewThread`; a failing resolution is logged and does not abort the rest;
- with findings: one `postReview` call, `commitId = headSha`, inline comments from `placeFindings().inline`, body = `renderReviewSummary` (includes the out-of-diff findings);
- without findings: one `postReview` call with no comments and the closing body — `'confirmed'` when it resolved ≥1 thread and none remain open, `{ open }` when open bot threads remain, `'lgtm'` otherwise;
- posts each `mentionReplies` entry via `replyToComment`, bodies passed through `neutralizeMentions`;
- logs every dropped finding (from parsing and placement) with its reason;
- `dryRun`: nothing in `github.js` that writes is called; the rendered summary, every inline comment, the planned resolutions and replies are written to `dryRun.outFile` as Markdown.

- [ ] **Step 2: Implement `runExternalReview`.**

- [ ] **Step 3: Wire into `tick.ts`** — `processExternalReviewCandidate` keeps its status/SHA/reaction bookkeeping and its try/catch; the body between the `pending` and `success` statuses becomes `await runExternalReview(candidate)`. Update its tests: `runAgentTask` assertions move to `review-publish.test.ts`; `tick.test.ts` mocks `review-publish.js` and keeps the "SHA only on success", "swallows errors" and reaction tests.

- [ ] **Step 4: `ReviewCandidate.baseRefName`** — populate from `ExternalPr.baseRefName` in `findPrsNeedingReview`; update `external-review.test.ts` expectations.

- [ ] **Step 5: `pnpm test` and `pnpm typecheck` pass. Commit.**

---

### Task 8: Dry-run script

**Files:**
- Create: `scripts/review-dry-run.ts`
- Modify: `package.json` (`"review:dry-run": "tsx scripts/review-dry-run.ts"`)

- [ ] **Step 1: Implement**

Usage: `pnpm review:dry-run --repo redmotos/shoppingcart --pr 746 --sha 62b66af [--out logs/dry-run/746-62b66af.md]`.

- loads `repos.json` (`loadRepos`) and runs inside `withActiveRepo(entry, …)`, like `scripts/smoke-test.ts`;
- resolves the full SHA with `git rev-parse` in `productRepoPath`; fetches `pull/<n>/head` if the object is missing (old force-pushed SHAs are usually still local — they were for every SHA in the spec's evidence);
- reads `baseRefName` with `gh pr view <n> --json baseRefName`;
- builds a `ReviewCandidate` with `openThreads: []`, `mentions: []` and calls `runExternalReview(candidate, { dryRun: { outFile } })`;
- default `--out`: `logs/dry-run/<pr>-<sha7>.md` (`logs/` is already gitignored).

- [ ] **Step 2: Manual check** — run it on `#746 @ 62b66af`; the output file exists and contains a summary table and at least one rendered comment. Commit.

---

### Task 9: Stage 1 validation and docs

- [ ] **Step 1: Dry-runs from the spec's validation section that Stage 1 can already answer:**
  - `#746 @ 62b66af` and `#753 @ be8d2ad` (full): do the 200-row limit and `CONCURRENTLY` appear?
  - `#760 @ 6de59df` (full): does one systemic finding cover lock + revalidation (client, `IgnoreCreditLimit`, lines)?
  - Format: read every rendered comment; each one must be decidable without expanding anything.
  Record results (found / not found, length of visible part) in the PR description of this stage.
- [ ] **Step 2:** Add a line to the top of `docs/superpowers/specs/2026-08-20-external-pr-review-design.md` pointing to the new spec for posting and comment format ("reemplazado en parte por …").
- [ ] **Step 3:** `pnpm test && pnpm typecheck && pnpm build`. Commit.

---

## Stage 2 — Incremental mode (outline, expand before starting)

### Task 10: Last reviewed SHA from GitHub, pinned locally
- `github.ts`: `getLastBotReviewSha(prNumber, botLogin)` — last review by the bot, `commit_id`.
- `worktree.ts`: `isCommitAvailable`, `fetchCommit` (`git fetch origin <sha>`), `pinReviewedSha` (`refs/ronin/reviewed/<n>`), `unpinReviewedSha`.
- `external-review.ts`: `previousSha` from GitHub (cache: `lastReviewedSha`); unavailable → `mode: 'full'` + `log.info`. Prune also unpins.
- `review-publish.ts`: pin after a successful publish; pin failure logged, never fails the review.

### Task 11: Content-based scope
- `review-scope.ts`: `prAddedLines(sha, baseRef)` (normalized content per path), `classifyChangedLines(prevSha, headSha, baseRef)`.
- Fixture tests: amend, several commits, rebase onto a moved base, merge of the base into the branch, shifted lines, moved identical line (counts as reviewed — documented limitation).

### Task 12: Scope rules and dedupe in code
- `applyScopeRules(findings, changedLines, mode, mentionIds)`: in `incremental`, on reviewed lines drop `minor` and every `improvement`; drop `critical`/`important` without `scenario` + `evidence`; mention-requested findings exempt.
- `dedupeAgainstOpenThreads`: same path + category + |line diff| ≤ 5.
- Marker `scope=` now real (`changed`/`reviewed`).
- Dropped findings logged and counted in `log.metric('external_review_dropped', …)`.

### Task 13: Full thread history
- `fetchReviewThreads` replaces `fetchOpenReviewThreads`, adding `isResolved`, `isOutdated`, `path`, `line`, `originalLine`, `diffHunk`, all comments, first-comment reactions. Existing filters keep their behavior.
- `listBotReviewThreads` (open + resolved) → `ReviewCandidate.threadHistory`.
- Prompt: history section with "don't re-raise resolved unless regressed; don't contradict a previous suggestion unless critical, explaining why"; human dismissal reasons (replies, 👎) included.

### Task 14: Delta subagent + Stage 2 validation
- Prompt: in `incremental`, the exact changed lines per file and a dedicated subagent for them and their callers.
- Dry-run script gains `--prev <sha>`; run every consecutive round pair of #746/#753/#760 and compare against the spec's evidence table. Success: no 🟡 published on reviewed code; the 🟠 that ended up fixed still appear.

## Stage 3 — Self-review in fix tasks (outline)

### Task 15
- `agent-task.ts`: a `selfReviewBlock(criteriaText)` appended to `fix-review`, `fix-comments`, `fix-comments-external` and the apply branch of `review-request`: before pushing, diff against the pre-fix HEAD, review it with the criteria, check it does not contradict an earlier bot suggestion on the PR; fix in the same pass or say so in the thread reply.
- `runAgentTask` loads the criteria for those task types.
- Validation: re-run #753's R2 fix in a throwaway worktree; it must not introduce the constant in the migration.

## Stage 4 — Test-based verification (outline)

### Task 16
- `ReviewCandidate.isCrossRepository` → task `canExecute`.
- Prompt (only when `canExecute`): for up to 3 `bug` findings with severity `critical`/`important` (critical first), write a test in the worktree, run it with the repo's documented test command, and fill `verification` — fails → `verified` with the test attached; passes → drop the finding; not reasonably testable or could not run → `reasoned` with the reason.
- Render: `Comprobado` + collapsed test code and output.
- Fork PRs: prompt has no execution section; any `verified` in the output is downgraded to `reasoned` by the supervisor.
- Validation: dry-run on #760 @ `66d85a6`; the `ChangeClient` race is expected to stay `reasoned` (non-deterministic interleaving), simpler bugs from #753 to reach `verified`.
