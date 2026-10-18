import { describe, it, expect, vi } from 'vitest';

// Deliberate, narrow exception to this repo's "github.ts has no test file"
// convention: isExternalReviewable is pure logic with no `gh` shelling, and
// it is the only guard keeping ronin from auto-reviewing its own PRs and
// other people's drafts — see final review Fix 6. Nothing else in github.ts
// is tested here, except lastMarkedReviewSha — pure too, and the only thing
// deciding which commit the incremental review diffs against, and threadOf —
// pure too, and what tells the agent which thread a mention lives in, and
// changesRequestedOn — pure too, and what keeps fix-review from looping on a
// review ronin already answered, and checksStatus — pure too, and what every
// CI decision on a slice PR reads, and reviewerDecisions — pure too, and
// who the dashboard says approved a PR.
vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
  LABEL_MANAGED: 'ronin',
  LABEL_STATES: [],
  LABEL_DIRECT_ISSUE: 'ronin:issue-fix',
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));

const { attemptCountFromLabels, isTransientGhError, isExternalReviewable, lastMarkedReviewSha, threadOf, changesRequestedOn, checksStatus, reviewerDecisions } = await import('./github.js');

describe('changesRequestedOn', () => {
  const review = (login: string, state: string, commitId: string) => ({ login, state, commitId });

  it('is true when the standing review asks for changes on the head', () => {
    expect(changesRequestedOn([review('ana', 'CHANGES_REQUESTED', 'head')], 'head')).toBe(true);
  });

  it('is false when the changes were requested on an older commit (redmotos/shoppingcart#802)', () => {
    const reviews = [review('ana', 'CHANGES_REQUESTED', 'old'), review('ronin', 'COMMENTED', 'head')];
    expect(changesRequestedOn(reviews, 'head')).toBe(false);
  });

  it('ignores a later plain comment from the same reviewer, like GitHub does', () => {
    const reviews = [review('ana', 'CHANGES_REQUESTED', 'head'), review('ana', 'COMMENTED', 'head')];
    expect(changesRequestedOn(reviews, 'head')).toBe(true);
  });

  it('is false once that reviewer approves', () => {
    const reviews = [review('ana', 'CHANGES_REQUESTED', 'head'), review('ana', 'APPROVED', 'head')];
    expect(changesRequestedOn(reviews, 'head')).toBe(false);
  });
});

describe('isExternalReviewable', () => {
  it('excludes a draft PR', () => {
    expect(isExternalReviewable({ isDraft: true, author: { login: 'someone' } }, 'ronin')).toBe(false);
  });

  it('excludes a PR authored by the bot itself', () => {
    expect(isExternalReviewable({ isDraft: false, author: { login: 'ronin' } }, 'ronin')).toBe(false);
  });

  it('includes a non-draft PR authored by someone else', () => {
    expect(isExternalReviewable({ isDraft: false, author: { login: 'someone' } }, 'ronin')).toBe(true);
  });

  it('includes a PR with a null author (deleted/ghost account is not the bot)', () => {
    expect(isExternalReviewable({ isDraft: false, author: null }, 'ronin')).toBe(true);
  });

  it('still excludes a draft PR authored by the bot itself', () => {
    expect(isExternalReviewable({ isDraft: true, author: { login: 'ronin' } }, 'ronin')).toBe(false);
  });
});

describe('lastMarkedReviewSha', () => {
  const marker = (sha: string) => `<!-- ronin:review v=2 sha=${sha} mode=full criteria=abc -->\n## Review de ronin`;

  it('returns the SHA of the latest review carrying the marker', () => {
    const sha = lastMarkedReviewSha(
      [
        { login: 'ronin', body: marker('aaaaaaa1'), submittedAt: '2026-10-01T00:00:00Z' },
        { login: 'ronin', body: marker('bbbbbbb2'), submittedAt: '2026-10-03T00:00:00Z' },
        { login: 'ronin', body: marker('ccccccc3'), submittedAt: '2026-10-02T00:00:00Z' },
      ],
      'ronin',
    );
    expect(sha).toBe('bbbbbbb2');
  });

  it('ignores the bot reviews without the marker — replies to inline comments create those too', () => {
    const sha = lastMarkedReviewSha(
      [
        { login: 'ronin', body: marker('aaaaaaa1'), submittedAt: '2026-10-01T00:00:00Z' },
        { login: 'ronin', body: '', submittedAt: '2026-10-05T00:00:00Z' },
        { login: 'ronin', body: 'Revisión automática.', submittedAt: '2026-10-06T00:00:00Z' },
      ],
      'ronin',
    );
    expect(sha).toBe('aaaaaaa1');
  });

  it('ignores a marker written by anyone else', () => {
    expect(lastMarkedReviewSha([{ login: 'mallory', body: marker('ddddddd4'), submittedAt: '2026-10-09T00:00:00Z' }], 'ronin')).toBeUndefined();
  });

  it('is undefined when nothing matches', () => {
    expect(lastMarkedReviewSha([], 'ronin')).toBeUndefined();
  });
});

describe('threadOf', () => {
  const raw = (id: number, extra: Record<string, unknown> = {}) => ({ id, body: `c${id}`, reactions: { eyes: 0 }, user: { login: `u${id}` }, ...extra });
  const root = raw(10, { path: 'a.ts', line: 7, diff_hunk: '@@ hunk' });
  const reply = raw(20, { path: 'a.ts', line: null, in_reply_to_id: 10 });
  const other = raw(15, { path: 'b.ts', line: 3, diff_hunk: '@@ other' });
  const all = [reply, other, root];

  it('rebuilds a reply\'s thread from its root, oldest first, without other threads', () => {
    expect(threadOf(reply, all)).toEqual({
      path: 'a.ts',
      line: 7,
      diffHunk: '@@ hunk',
      comments: [
        { id: 10, authorLogin: 'u10', body: 'c10' },
        { id: 20, authorLogin: 'u20', body: 'c20' },
      ],
    });
  });

  it('gives a thread\'s first comment the same thread', () => {
    expect(threadOf(root, all)).toEqual(threadOf(reply, all));
  });

  it('falls back to the comment itself when its root is not in the list', () => {
    expect(threadOf(reply, [reply])).toMatchObject({ path: 'a.ts', line: null, comments: [{ id: 20 }] });
  });
});

describe('isTransientGhError', () => {
  it('recognizes GitHub or the network failing for a moment', () => {
    expect(isTransientGhError(new Error('Command failed: gh issue view 350 --json body --repo Bmedical/bmedical\nHTTP 500: 500 Internal Server Error (https://api.github.com/graphql)'))).toBe(true);
    expect(isTransientGhError(new Error('Command failed: gh pr list\nHTTP 502: Bad Gateway'))).toBe(true);
    expect(isTransientGhError(new Error('Command failed: gh api repos/x\nPost "https://api.github.com/graphql": read tcp: connection reset by peer'))).toBe(true);
  });

  it('leaves real errors and other commands out', () => {
    expect(isTransientGhError(new Error('Command failed: gh issue view 9\nGraphQL: Could not resolve to an issue'))).toBe(false);
    expect(isTransientGhError(new Error('Command failed: gh pr edit 3\nHTTP 422: Validation Failed'))).toBe(false);
    expect(isTransientGhError(new Error('claude exited with code 1: HTTP 500'))).toBe(false);
  });
});

describe('attemptCountFromLabels', () => {
  it('reads the counter, or 0 without one', () => {
    expect(attemptCountFromLabels(['ronin', 'ronin:attempts-5'])).toBe(5);
    expect(attemptCountFromLabels(['ronin'])).toBe(0);
  });
});

describe('checksStatus', () => {
  const run = (conclusion: string | null) => ({ __typename: 'CheckRun' as const, conclusion });
  const status = (context: string, state: string) => ({ __typename: 'StatusContext' as const, context, state });

  it('passes when every check run succeeded, neutral and skipped included', () => {
    expect(checksStatus([run('SUCCESS'), run('NEUTRAL'), run('SKIPPED')])).toEqual({ checksPassing: true, checksPending: false });
  });

  it('is pending while a check run has no conclusion yet, null or empty', () => {
    expect(checksStatus([run('SUCCESS'), run(null)])).toEqual({ checksPassing: false, checksPending: true });
    expect(checksStatus([run('')]).checksPending).toBe(true);
  });

  it('fails on a failed check run', () => {
    expect(checksStatus([run('SUCCESS'), run('FAILURE')])).toEqual({ checksPassing: false, checksPending: false });
  });

  it('reads a commit status by its state, not by a conclusion it never has', () => {
    expect(checksStatus([run('SUCCESS'), status('vercel', 'SUCCESS')])).toEqual({ checksPassing: true, checksPending: false });
    expect(checksStatus([status('vercel', 'PENDING')]).checksPending).toBe(true);
    expect(checksStatus([run('SUCCESS'), status('vercel', 'ERROR')])).toEqual({ checksPassing: false, checksPending: false });
  });

  it("ignores ronin's own statuses: a slice PR it reviewed is still green (Bmedical/bmedical#401)", () => {
    expect(checksStatus([run('SUCCESS'), run('SUCCESS'), status('ronin/review', 'SUCCESS')]))
      .toEqual({ checksPassing: true, checksPending: false });
    expect(checksStatus([run('SUCCESS'), status('ronin/fix-comments', 'ERROR')]))
      .toEqual({ checksPassing: true, checksPending: false });
  });

  it('is pending with no CI at all, even when ronin left a status', () => {
    expect(checksStatus([])).toEqual({ checksPassing: false, checksPending: true });
    expect(checksStatus([status('ronin/review', 'SUCCESS')])).toEqual({ checksPassing: false, checksPending: true });
  });
});

describe('reviewerDecisions', () => {
  const r = (author: string, state: string, submittedAt: string) => ({ author, state, submittedAt });
  it('keeps each reviewer\'s latest decision: a comment leaves it, a dismissal or a new decision replaces it', () => {
    expect(reviewerDecisions([
      r('ana', 'CHANGES_REQUESTED', '2026-10-18T10:00:00Z'),
      r('beto', 'APPROVED', '2026-10-18T09:00:00Z'),
      r('ana', 'APPROVED', '2026-10-18T11:00:00Z'),
      r('ana', 'COMMENTED', '2026-10-18T12:00:00Z'),
      r('caro', 'APPROVED', '2026-10-18T08:00:00Z'),
      r('caro', 'DISMISSED', '2026-10-18T13:00:00Z'),
    ])).toEqual([{ author: 'beto', state: 'APPROVED' }, { author: 'ana', state: 'APPROVED' }]);
  });
});
