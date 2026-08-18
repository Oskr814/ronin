# Agent-Notes Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a short prompt reminder so six of the seven `AgentTask` types tell the headless agent to record non-obvious learnings in `PRODUCT_REPO`'s `docs/agent-notes/` convention, as part of the same commit they're already making.

**Architecture:** One new exported string constant in `src/agent-task.ts` (`AGENT_NOTES_REMINDER`), appended as the last element of the prompt array in the `implement-slice`, `fix-bug`, `fix-review`, `fix-e2e`, `fix-rebase`, and `review-request` cases of `buildTask`. The `plan` case is untouched. No other module changes — `tick.ts`, `github.ts`, `claim.ts`, etc. don't need to know this exists.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-notes-design.md`

## Global Constraints

- The reminder text is a single shared constant, not six copy-pasted literals — same DRY pattern the file already uses informally for its repeated "Do not edit the tracking issue..." lines.
- It is the **last** element of the prompt array in each of the six cases (after everything else, including the existing "Do not edit the tracking issue..." line).
- The `plan` case does **not** get the reminder — it never touches code, so there's nothing non-obvious to record yet.
- Do not touch `src/worktree.ts` — it has an unrelated, pre-existing uncommitted change from other in-progress work. Do not stage, commit, or revert it.
- No new files, no new modules, no changes to `tick.ts`/`github.ts`/`claim.ts`/`stack.ts`. This plan touches exactly two files: `src/agent-task.ts` and `src/agent-task.test.ts`.
- Bootstrapping `docs/agent-notes/INDEX.md` and the `CLAUDE.md` section in `bmedical` is explicitly out of scope (manual step, per the spec's "Fuera de alcance").

---

### Task 1: Add `AGENT_NOTES_REMINDER` and wire it into the six prompts

**Files:**
- Modify: `src/agent-task.ts`
- Test: `src/agent-task.test.ts`

**Interfaces:**
- Produces: `export const AGENT_NOTES_REMINDER: string` — importable from `./agent-task.js` for tests (and by nothing else; the six `case` branches use it directly as a local reference within the same file).

- [ ] **Step 1: Write the failing tests for all seven task types**

Add this new `describe` block to `src/agent-task.test.ts`, right after the existing `describe('runAgentTask — agent-run metrics', ...)` block (i.e. at the end of the file). It needs `AGENT_NOTES_REMINDER` added to the existing `agent-task.js` import on line 33:

```ts
const { runAgentTask, AGENT_NOTES_REMINDER } = await import('./agent-task.js');
```

Then append:

```ts
describe('runAgentTask — agent-notes reminder', () => {
  it('is included for implement-slice', async () => {
    await runAgentTask({ type: 'implement-slice', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Add foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is included for fix-bug', async () => {
    await runAgentTask({ type: 'fix-bug', issueNumber: 228, sliceIndex: 0, sliceTitle: 'Fix foo' });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is included for fix-review', async () => {
    await runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is included for fix-e2e', async () => {
    await runAgentTask({ type: 'fix-e2e', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is included for fix-rebase', async () => {
    await runAgentTask({ type: 'fix-rebase', issueNumber: 228, prNumber: 229 });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is included for review-request', async () => {
    await runAgentTask({
      type: 'review-request',
      issueNumber: 228,
      prNumber: 229,
      mentions: [{ id: 1, kind: 'issue' as const, body: 'test', reactionsEyes: 0 }],
    });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain(AGENT_NOTES_REMINDER);
  });

  it('is NOT included for plan', async () => {
    await runAgentTask({ type: 'plan', issueNumber: 228, specPaths: ['docs/superpowers/specs/foo.md'] });

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).not.toContain(AGENT_NOTES_REMINDER);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/link/Bmedical/ValerIA && pnpm test -- src/agent-task.test.ts`

(Ronin's `test` script is plain `vitest run` at the repo root — no workspace filter needed here, unlike bmedical.)

Expected: FAIL — `AGENT_NOTES_REMINDER` imports as `undefined` (it doesn't exist yet in `agent-task.ts`), so every `toContain(undefined)` assertion throws/fails, including the seven new tests.

- [ ] **Step 3: Add the constant and wire it into the six prompts**

In `src/agent-task.ts`, add the constant right after the existing `repoUrl` helper (after line 22, before `async function buildTask`):

```ts
function repoUrl(): string {
  return `https://github.com/${config.productRepo}`;
}

export const AGENT_NOTES_REMINDER =
  "If you learned something non-obvious while doing this (a hidden " +
  "constraint, a subtle invariant, a workaround for a specific bug) that " +
  "would help a future task or a human dev, record it now as part of this " +
  "same commit, following the agent-notes convention in this repo's " +
  "CLAUDE.md.";
```

Then, in each of the six cases, append `AGENT_NOTES_REMINDER` as the last element of the prompt array (after the existing last line, before `].join('\n')`).

**`implement-slice`** — old:
```ts
          'Scope: only touch files needed for this slice. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```
new:
```ts
          'Scope: only touch files needed for this slice. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
```

**`fix-bug`** — old:
```ts
          `When done: run the relevant tests, and make exactly one commit for this fix. Push this branch and open a PR ("gh pr create") with "Closes #${task.issueNumber}" in the body, describing the root cause and the fix.`,
          'Scope: only touch files needed for this fix. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```
new:
```ts
          `When done: run the relevant tests, and make exactly one commit for this fix. Push this branch and open a PR ("gh pr create") with "Closes #${task.issueNumber}" in the body, describing the root cause and the fix.`,
          'Scope: only touch files needed for this fix. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
```

**`fix-review`** — this exact closing line also appears verbatim in `fix-e2e` and `fix-rebase`, so edit each case using enough surrounding context to target the right one (each case's opening lines are unique). For `fix-review`, old:
```ts
    case 'fix-review': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) has unresolved review comments.`,
          `Read them with "gh pr view ${task.prNumber} --comments", apply the necessary changes following this repo's CLAUDE.md conventions, then amend the existing commit (\`git commit --amend\`) — never create a new commit — and force-push (\`git push --force-with-lease\`) to this same branch.`,
          'The spec is a guide written before implementation started, not a contract that overrides a human catching something during review — if a comment gives a clear, concrete rationale for a change that deviates from what the spec says (e.g. it missed an edge case, or points out a real bug/gap), apply it using your own judgment. Only leave the PR as-is and defer to a human when the request is ambiguous, a matter of opinion, or needs a design decision the spec does not already resolve.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```
new (only the array gains one line before `.join`):
```ts
    case 'fix-review': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) has unresolved review comments.`,
          `Read them with "gh pr view ${task.prNumber} --comments", apply the necessary changes following this repo's CLAUDE.md conventions, then amend the existing commit (\`git commit --amend\`) — never create a new commit — and force-push (\`git push --force-with-lease\`) to this same branch.`,
          'The spec is a guide written before implementation started, not a contract that overrides a human catching something during review — if a comment gives a clear, concrete rationale for a change that deviates from what the spec says (e.g. it missed an edge case, or points out a real bug/gap), apply it using your own judgment. Only leave the PR as-is and defer to a human when the request is ambiguous, a matter of opinion, or needs a design decision the spec does not already resolve.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
```

**`fix-e2e`** — old:
```ts
    case 'fix-e2e': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. CI/e2e checks (Playwright) are failing on PR #${task.prNumber} (tracking issue #${task.issueNumber}).`,
          'Investigate the cause, fix it, and confirm the affected e2e spec(s) pass by re-running them (`pnpm --filter @bmedical/webapp exec playwright test`), then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
          'Leave the resulting output under apps/webapp/test-results/ as-is; do not move, copy, or commit it — the supervisor collects it separately.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```
new:
```ts
    case 'fix-e2e': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. CI/e2e checks (Playwright) are failing on PR #${task.prNumber} (tracking issue #${task.issueNumber}).`,
          'Investigate the cause, fix it, and confirm the affected e2e spec(s) pass by re-running them (`pnpm --filter @bmedical/webapp exec playwright test`), then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
          'Leave the resulting output under apps/webapp/test-results/ as-is; do not move, copy, or commit it — the supervisor collects it separately.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
```

**`fix-rebase`** — old:
```ts
    case 'fix-rebase': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) is behind \`${config.worktreeBaseRef}\` and couldn't be rebased mechanically — it hit a real conflict.`,
          `Run \`git fetch origin\` and \`git rebase ${config.worktreeBaseRef}\` in this worktree, and resolve the conflicts following this repo's CLAUDE.md conventions and the spec — do not deviate from what the spec explicitly requires.`,
          'Re-run the relevant tests after resolving, then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
          'If a conflict requires a decision the spec does not clearly resolve, stop and leave the branch as-is — that needs a human decision, do not guess.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```
new:
```ts
    case 'fix-rebase': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) is behind \`${config.worktreeBaseRef}\` and couldn't be rebased mechanically — it hit a real conflict.`,
          `Run \`git fetch origin\` and \`git rebase ${config.worktreeBaseRef}\` in this worktree, and resolve the conflicts following this repo's CLAUDE.md conventions and the spec — do not deviate from what the spec explicitly requires.`,
          'Re-run the relevant tests after resolving, then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
          'If a conflict requires a decision the spec does not clearly resolve, stop and leave the branch as-is — that needs a human decision, do not guess.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
```

**`review-request`** — old (last two lines of the array):
```ts
          'Never approve, request changes, or merge this PR, and never run "gh pr review" under any circumstance — replies are comments, not review verdicts. Merge approval is reserved for a human, not for you.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
  }
}
```
new:
```ts
          'Never approve, request changes, or merge this PR, and never run "gh pr review" under any circumstance — replies are comments, not review verdicts. Merge approval is reserved for a human, not for you.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
          AGENT_NOTES_REMINDER,
        ].join('\n'),
      };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/link/Bmedical/ValerIA && pnpm test -- src/agent-task.test.ts`
Expected: PASS — all pre-existing tests plus the seven new ones in `runAgentTask — agent-notes reminder`.

- [ ] **Step 5: Type-check**

Run: `cd /home/link/Bmedical/ValerIA && pnpm typecheck`
Expected: no errors. (`AGENT_NOTES_REMINDER` is a plain exported `string`, no type surface beyond that.)

- [ ] **Step 6: Commit**

```bash
cd /home/link/Bmedical/ValerIA
git add src/agent-task.ts src/agent-task.test.ts
git commit -m "$(cat <<'EOF'
feat: remind the agent to record non-obvious learnings in agent-notes

Every AgentTask except plan now ends its prompt with a pointer to the
docs/agent-notes/ convention (see docs/superpowers/specs/2026-08-18-agent-notes-design.md),
so gotchas discovered during a tick aren't lost the moment its
fresh-context session ends.
EOF
)"
```

This is the only task — do not push or open a PR as part of this plan; that's a separate step once the branch is reviewed.

---

## Self-Review Notes

- **Spec coverage:** The spec's only code-level requirement (§"Diseño" → `src/agent-task.ts`) is fully covered by Task 1. The bootstrap step (`docs/agent-notes/INDEX.md` + bmedical `CLAUDE.md` section) is explicitly out of scope per the spec's own "Fuera de alcance" section — no task needed for it here.
- **Placeholder scan:** No TBDs; every step has literal code, not a description of code.
- **Type consistency:** `AGENT_NOTES_REMINDER` is referenced with the exact same name in the test import, the six wiring edits, and the export declaration.
