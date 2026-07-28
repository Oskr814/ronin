import { ensureWorktree } from './worktree.js';
import { runClaudeHeadless } from './claude-runner.js';
import { getPullRequestStatus } from './github.js';
import { config } from './config.js';

export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPath: string }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number };

function repoUrl(): string {
  return `https://github.com/${config.productRepo}`;
}

// Placeholder slug — once slice titles are used for the branch name instead
// of the raw index, this and the regex below need to move to a slugify
// scheme instead of a fixed-format parse. Exported so tick.ts can recover
// the slice index from an already-open PR's branch name.
export function sliceBranch(issueNumber: number, sliceIndex: number): string {
  return `valeria/${issueNumber}/slice-${sliceIndex + 1}`;
}

const SLICE_BRANCH_RE = /^valeria\/\d+\/slice-(\d+)$/;

export function sliceIndexFromBranch(branch: string): number | null {
  const match = branch.match(SLICE_BRANCH_RE);
  return match ? Number(match[1]) - 1 : null;
}

async function buildTask(task: AgentTask): Promise<{ branch: string; prompt: string }> {
  switch (task.type) {
    case 'plan':
      return {
        branch: `valeria/${task.issueNumber}/plan`,
        prompt: [
          `You are ValerIA, an autonomous agent working on tracking issue #${task.issueNumber} in ${repoUrl()}.`,
          `Read the spec at "${task.specPath}" (inside this checkout).`,
          'Design the implementation plan, sliced into small, independently reviewable pieces (use the planning skill if one is available).',
          `Rewrite the body of issue #${task.issueNumber} (gh issue edit ${task.issueNumber} --body-file <file>), replacing the templates/tracking-issue.md checklist with the real slices, one line per slice in the format "- [ ] Slice N: <title> — PR: _pending_".`,
          'Do not implement any code yet — this task is plan-only.',
        ].join('\n'),
      };

    case 'implement-slice':
      return {
        branch: sliceBranch(task.issueNumber, task.sliceIndex),
        prompt: [
          `You are ValerIA, an autonomous agent working on tracking issue #${task.issueNumber} in ${repoUrl()}.`,
          `Read the slice checklist in the issue (gh issue view ${task.issueNumber}) and implement slice number ${task.sliceIndex + 1}.`,
          "Follow this repo's CLAUDE.md conventions, including its testing requirements.",
          'When done: run the relevant tests, commit and push this branch, and open a PR against main (gh pr create) describing the slice. You do not need to edit the issue checklist yourself — the supervisor updates it with the PR number.',
        ].join('\n'),
      };

    case 'fix-review': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) has unresolved review comments.`,
          `Read them with "gh pr view ${task.prNumber} --comments", apply the necessary changes following this repo's CLAUDE.md conventions, and commit and push to this same branch.`,
          'If any comment contradicts what the spec explicitly requires, do not apply it — leave the PR as-is and do not touch anything else; that needs a human decision.',
        ].join('\n'),
      };
    }

    case 'fix-e2e': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. CI/e2e checks (Playwright) are failing on PR #${task.prNumber} (tracking issue #${task.issueNumber}).`,
          'Investigate the cause, fix it, and commit and push to this same branch.',
        ].join('\n'),
      };
    }
  }
}

export async function runAgentTask(task: AgentTask): Promise<void> {
  const { branch, prompt } = await buildTask(task);
  const worktreeDir = await ensureWorktree(branch);
  await runClaudeHeadless(worktreeDir, prompt);
}
