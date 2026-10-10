import { describe, it, expect, vi } from 'vitest';

// Deliberate, narrow exception to this repo's "github.ts has no test file"
// convention: isExternalReviewable is pure logic with no `gh` shelling, and
// it is the only guard keeping ronin from auto-reviewing its own PRs and
// other people's drafts — see final review Fix 6. Nothing else in github.ts
// is tested here, except lastMarkedReviewSha — pure too, and the only thing
// deciding which commit the incremental review diffs against.
vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
  LABEL_MANAGED: 'ronin',
  LABEL_STATES: [],
  LABEL_DIRECT_ISSUE: 'ronin:issue-fix',
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));

const { isExternalReviewable, lastMarkedReviewSha } = await import('./github.js');

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
