import type { PullRequestStatus } from '@platform/github/github.js';

// Placeholder slug — once slice titles are used for the branch name instead
// of the raw index, this and the regex below need to move to a slugify
// scheme instead of a fixed-format parse.
export function sliceBranch(issueNumber: number, sliceIndex: number): string {
  return `ronin/${issueNumber}/slice-${sliceIndex + 1}`;
}

// The 'plan' task's branch — never opens a PR (its job is to rewrite the
// tracking issue's body, see prompts.ts), so it's the one ronin branch
// that never goes through the merge-time worktree cleanup in tick.ts.
export function planBranch(issueNumber: number): string {
  return `ronin/${issueNumber}/plan`;
}

// The 'spike' task's branch — same reasoning as planBranch: only ever
// rewrites the issue body (see domains/commands/prompts.ts), never opens a PR, so its
// caller (processSpikeCandidate in tick.ts) is responsible for cleaning up
// the worktree itself, same as discoverAssignedSpecs does for planBranch.
export function spikeBranch(issueNumber: number): string {
  return `ronin/${issueNumber}/spike`;
}

// The 'write-spec' task's branch: it does open a PR (the spec, as a draft),
// but that PR is a spec PR — merged by discoverAssignedSpecs once a human
// marks it ready — never a slice of a tracking issue.
export function specBranch(issueNumber: number): string {
  return `ronin/${issueNumber}/spec`;
}

const SLICE_BRANCH_RE = /^ronin\/\d+\/slice-(\d+)$/;

const SLICE_ISSUE_RE = /^ronin\/(\d+)\/slice-\d+$/;

// The issue a slice branch belongs to: `ronin/350/slice-1` → 350.
export function issueFromSliceBranch(branch: string): number | null {
  const match = branch.match(SLICE_ISSUE_RE);
  return match ? Number(match[1]) : null;
}

export function sliceIndexFromBranch(branch: string): number | null {
  const match = branch.match(SLICE_BRANCH_RE);
  return match ? Number(match[1]) - 1 : null;
}

export interface StackedPr extends PullRequestStatus {
  sliceIndex: number;
}

// Slice branches are created as `ronin/<issue>/<slice-slug>` (see
// sliceBranch above), so an issue's open PRs are found by branch
// prefix out of the single batched list (see github.ts's
// listAllOpenRoninPrs) instead of a separate per-issue fetch — see
// docs/superpowers/specs/2026-08-01-pr-list-batching-design.md. Pure: no I/O,
// so it needs no mocking to test.
export function prsForIssue(allPrs: PullRequestStatus[], issueNumber: number): PullRequestStatus[] {
  const prefix = `ronin/${issueNumber}/`;
  return allPrs.filter((pr) => pr.headRefName.startsWith(prefix));
}

// Ordena por índice de slice; descarta cualquier PR cuyo branch no matchee el
// patrón ronin/<issue>/slice-N (ej. el branch de la tarea 'plan') — no
// debería pasar en la práctica, pero mejor un PR ignorado que uno mal indexado.
export function toStackedPrs(prs: PullRequestStatus[]): StackedPr[] {
  return prs
    .flatMap((pr) => {
      const sliceIndex = sliceIndexFromBranch(pr.headRefName);
      return sliceIndex === null ? [] : [{ ...pr, sliceIndex }];
    })
    .sort((a, b) => a.sliceIndex - b.sliceIndex);
}

// El único PR elegible para intentar merge: el de menor índice, sin importar
// el estado de aprobación de los que están más arriba en el stack.
export function pickBottomPr(prs: StackedPr[]): StackedPr | null {
  if (prs.length === 0) return null;
  return prs.reduce((bottom, pr) => (pr.sliceIndex < bottom.sliceIndex ? pr : bottom));
}

// Branch base para arrancar la próxima slice: el ref raíz (main) para la
// primera, o el branch de la slice anterior para cualquier otra — así cada
// slice se apila en contenido sobre la anterior sin esperar a que mergee.
export function baseBranchFor(sliceIndex: number, issueNumber: number, rootBaseRef: string): string {
  return sliceIndex === 0 ? rootBaseRef : sliceBranch(issueNumber, sliceIndex - 1);
}
