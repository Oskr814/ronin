import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoMergeCandidate } from '@platform/github/github.js';

vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin' }, LABEL_AUTO_MERGE: 'ronin:auto-merge' }));
const repo = vi.hoisted(() => ({ productRepo: 'acme/app', autoMerge: false as boolean | undefined }));
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => repo }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const listOpenPrsForAutoMerge = vi.fn();
const mergePullRequest = vi.fn();
const commentOnSpecPr = vi.fn();
const addIssueLabel = vi.fn();
const removeIssueLabel = vi.fn();
const replyToComment = vi.fn();
const addReaction = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  listOpenPrsForAutoMerge: (...args: unknown[]) => listOpenPrsForAutoMerge(...args),
  mergePullRequest: (...args: unknown[]) => mergePullRequest(...args),
  commentOnSpecPr: (...args: unknown[]) => commentOnSpecPr(...args),
  addIssueLabel: (...args: unknown[]) => addIssueLabel(...args),
  removeIssueLabel: (...args: unknown[]) => removeIssueLabel(...args),
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
}));

let defaulted: number[] | undefined;
const setAutoMergeDefaulted = vi.fn(async (prs: number[]) => {
  defaulted = prs;
});
vi.mock('@platform/state/local-state.js', () => ({
  getAutoMergeDefaulted: async () => defaulted,
  setAutoMergeDefaulted: (prs: number[]) => setAutoMergeDefaulted(prs),
}));

// Done-ness lives in the local state now (processed-comments.ts, tested on
// its own); here it's still read off the 👀, as these tests set it up.
vi.mock('@platform/state/processed-comments.js', () => ({
  markProcessed: (c: { id: number; kind: string }) => addReaction(c.id, c.kind, 'eyes'),
}));

const { applyAutoMergeCommand, autoMergeBlockers, labelNewSlicePrs, sweepAutoMerge } = await import('./auto-merge.js');

type Overrides = Partial<{ number: number; isDraft: boolean; reviewDecision: string; checksPassing: boolean; checksPending: boolean; mergeable: boolean; headRefName: string; baseRefName: string }>;

function candidate(overrides: Overrides = {}, extra: { conflicting?: boolean; labels?: string[] } = {}) {
  const number = overrides.number ?? 10;
  return {
    status: {
      number,
      state: 'OPEN',
      reviewDecision: 'APPROVED',
      checksPassing: true,
      checksPending: false,
      mergeable: true,
      headRefName: `feat/${number}`,
      baseRefName: 'main',
      isDraft: false,
      body: '',
      ...overrides,
    },
    conflicting: extra.conflicting ?? false,
    labels: extra.labels ?? ['ronin:auto-merge'],
  } as Parameters<typeof autoMergeBlockers>[0] & { labels: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mergePullRequest.mockResolvedValue(undefined);
  commentOnSpecPr.mockResolvedValue(undefined);
  addIssueLabel.mockResolvedValue(undefined);
  removeIssueLabel.mockResolvedValue(undefined);
  replyToComment.mockResolvedValue(undefined);
  addReaction.mockResolvedValue(undefined);
});

describe('autoMergeBlockers', () => {
  const none = new Map<string, number>();

  it('lets an approved, green, mergeable PR through', () => {
    expect(autoMergeBlockers(candidate(), none)).toEqual({ waits: [] });
  });

  it('waits for the approval, the checks and the draft', () => {
    expect(autoMergeBlockers(candidate({ reviewDecision: 'REVIEW_REQUIRED', checksPending: true, checksPassing: false, isDraft: true }), none).waits)
      .toEqual(['que deje de ser draft', 'una aprobación', 'que terminen los checks']);
    expect(autoMergeBlockers(candidate({ reviewDecision: 'CHANGES_REQUESTED', checksPassing: false }), none).waits)
      .toEqual(['que se resuelvan los cambios pedidos y lo aprueben', 'que pasen los checks que están fallando']);
    expect(autoMergeBlockers(candidate({ mergeable: false }), none).waits).toEqual(['que GitHub lo dé por mergeable']);
  });

  it('waits for the PR below it in a stack', () => {
    const pr = candidate({ number: 11, baseRefName: 'ronin/5/slice-1' });
    expect(autoMergeBlockers(pr, new Map([['ronin/5/slice-1', 10]])).waits).toEqual(['que se mergee #10, que está abajo en el stack']);
  });

  it('turns off on a conflict', () => {
    expect(autoMergeBlockers(candidate({}, { conflicting: true }), none).disable).toBe('tiene conflictos con `main`');
  });
});

describe('sweepAutoMerge', () => {
  it('merges a labeled PR that is ready and says so on the PR', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({ number: 10 }), candidate({ number: 12 }, { labels: [] })]);

    await sweepAutoMerge();

    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).toHaveBeenCalledWith(10);
    expect(commentOnSpecPr).toHaveBeenCalledWith(10, expect.stringContaining('Mergeado por auto-merge'));
  });

  it('only waits, silently, while something is missing', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({ checksPending: true })]);

    await sweepAutoMerge();

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(commentOnSpecPr).not.toHaveBeenCalled();
    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it('takes the label off and tells the PR on a conflict', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({}, { conflicting: true })]);

    await sweepAutoMerge();

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(removeIssueLabel).toHaveBeenCalledWith(10, 'ronin:auto-merge');
    expect(commentOnSpecPr).toHaveBeenCalledWith(10, expect.stringContaining('Desactivé el auto-merge de este PR: tiene conflictos'));
  });

  it('takes the label off when the merge fails, so it is not retried every tick', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate()]);
    mergePullRequest.mockRejectedValue(new Error('Base branch was modified\nmore'));

    await sweepAutoMerge();

    expect(removeIssueLabel).toHaveBeenCalledWith(10, 'ronin:auto-merge');
    expect(commentOnSpecPr).toHaveBeenCalledWith(10, expect.stringContaining('el merge falló (Base branch was modified)'));
  });

  it('reads nothing else when no PR has the label', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({}, { labels: [] })]);

    await sweepAutoMerge();

    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('applyAutoMergeCommand', () => {
  const comment = { id: 5, kind: 'issue' as const };

  it('turns it on and says what is still missing', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({ reviewDecision: 'REVIEW_REQUIRED' })]);

    await applyAutoMergeCommand(10, comment, 'on');

    expect(addIssueLabel).toHaveBeenCalledWith(10, 'ronin:auto-merge');
    expect(replyToComment).toHaveBeenCalledWith(10, comment, expect.stringContaining('Falta: una aprobación.'));
    expect(replyToComment.mock.calls[0][2]).toContain('`@ronin /auto-merge off`');
    expect(addReaction).toHaveBeenCalledWith(5, 'issue', 'eyes');
  });

  it('does not turn it on for a PR that already conflicts', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate({}, { conflicting: true })]);

    await applyAutoMergeCommand(10, comment, 'on');

    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(replyToComment).toHaveBeenCalledWith(10, comment, expect.stringContaining('No activé el auto-merge: este PR tiene conflictos'));
  });

  it('turns it off, even when the label was not there', async () => {
    removeIssueLabel.mockRejectedValue(new Error("'ronin:auto-merge' not found"));

    await applyAutoMergeCommand(10, comment, 'off');

    expect(replyToComment).toHaveBeenCalledWith(10, comment, expect.stringContaining('Auto-merge desactivado'));
    expect(addReaction).toHaveBeenCalledWith(5, 'issue', 'eyes');
  });

  it('leaves no 👀 when the reply failed, so the next tick retries', async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([candidate()]);
    replyToComment.mockRejectedValue(new Error('gh down'));

    await expect(applyAutoMergeCommand(10, comment, 'on')).rejects.toThrow('gh down');
    expect(addReaction).not.toHaveBeenCalled();
  });
});

describe('labelNewSlicePrs', () => {
  const slice = (number: number, extra: { conflicting?: boolean; labels?: string[] } = {}) =>
    candidate({ number, headRefName: `ronin/50/slice-${number}`, reviewDecision: 'REVIEW_REQUIRED' }, { labels: [], ...extra }) as unknown as AutoMergeCandidate;

  beforeEach(() => {
    defaulted = [];
  });

  it("labels a slice PR it hasn't seen, and only slice PRs", async () => {
    const prs = [slice(3), candidate({ number: 4, headRefName: 'ronin/50/spec' }, { labels: [] }), candidate({ number: 5, headRefName: 'ronin/exploration/2026-10-12' }, { labels: [] }), candidate({ number: 6 }, { labels: [] })] as unknown as AutoMergeCandidate[];
    await labelNewSlicePrs(prs);
    expect(addIssueLabel).toHaveBeenCalledTimes(1);
    expect(addIssueLabel).toHaveBeenCalledWith(3, 'ronin:auto-merge');
    expect(prs[0].labels).toContain('ronin:auto-merge');
    expect(defaulted).toEqual([3]);
  });

  it('never puts it back on a PR that already had it once (taking it off sticks)', async () => {
    defaulted = [3];
    await labelNewSlicePrs([slice(3)]);
    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(setAutoMergeDefaulted).not.toHaveBeenCalled();
  });

  it('the first run only records the PRs already open', async () => {
    defaulted = undefined;
    await labelNewSlicePrs([slice(3), slice(4)]);
    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(defaulted).toEqual([3, 4]);
  });

  it("records a conflicting PR without labeling it, and drops the ones that aren't open", async () => {
    defaulted = [1, 2];
    await labelNewSlicePrs([slice(2), slice(3, { conflicting: true })]);
    expect(addIssueLabel).not.toHaveBeenCalled();
    expect(defaulted).toEqual([2, 3]);
  });

  it('tries again next tick when the label fails', async () => {
    addIssueLabel.mockRejectedValueOnce(new Error('boom'));
    await labelNewSlicePrs([slice(3), slice(4)]);
    expect(defaulted).toEqual([4]);
  });

  it("sweepAutoMerge labels new slice PRs unless the repo's autoMerge is false", async () => {
    listOpenPrsForAutoMerge.mockResolvedValue([slice(3)]);
    await sweepAutoMerge();
    expect(addIssueLabel).not.toHaveBeenCalled();
    repo.autoMerge = undefined;
    try {
      await sweepAutoMerge();
    } finally {
      repo.autoMerge = false;
    }
    expect(addIssueLabel).toHaveBeenCalledWith(3, 'ronin:auto-merge');
    // Labeled, it waits for its approval like any other.
    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});
