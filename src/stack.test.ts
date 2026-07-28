import { describe, it, expect } from 'vitest';
import type { PullRequestStatus } from './github.js';
import { sliceBranch, sliceIndexFromBranch, toStackedPrs, pickBottomPr, baseBranchFor } from './stack.js';

describe('sliceBranch / sliceIndexFromBranch', () => {
  it('round-trips a slice index through a branch name', () => {
    expect(sliceBranch(228, 0)).toBe('valeria/228/slice-1');
    expect(sliceIndexFromBranch('valeria/228/slice-1')).toBe(0);
  });

  it('returns null for a branch that does not match the slice pattern', () => {
    expect(sliceIndexFromBranch('valeria/228/plan')).toBeNull();
  });
});

function pr(headRefName: string, overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 1,
    state: 'OPEN',
    reviewDecision: '',
    checksPassing: true,
    checksPending: false,
    mergeable: true,
    headRefName,
    baseRefName: 'main',
    isDraft: false,
    ...overrides,
  };
}

describe('toStackedPrs', () => {
  it('sorts by slice index and drops non-slice branches', () => {
    const prs = [
      pr('valeria/228/slice-2', { number: 230 }),
      pr('valeria/228/slice-1', { number: 229 }),
      pr('valeria/228/plan', { number: 1 }),
    ];
    expect(toStackedPrs(prs).map((p) => [p.sliceIndex, p.number])).toEqual([
      [0, 229],
      [1, 230],
    ]);
  });
});

describe('pickBottomPr', () => {
  it('returns the lowest slice index even if a higher one is approved first', () => {
    const stack = toStackedPrs([
      pr('valeria/228/slice-2', { number: 230, reviewDecision: 'APPROVED' }),
      pr('valeria/228/slice-1', { number: 229, reviewDecision: '' }),
    ]);
    expect(pickBottomPr(stack)?.number).toBe(229);
  });

  it('returns null for an empty stack', () => {
    expect(pickBottomPr([])).toBeNull();
  });
});

describe('baseBranchFor', () => {
  it('uses the root base ref for the first slice', () => {
    expect(baseBranchFor(0, 228, 'origin/main')).toBe('origin/main');
  });

  it('chains onto the previous slice branch otherwise', () => {
    expect(baseBranchFor(2, 228, 'origin/main')).toBe('valeria/228/slice-2');
  });
});
