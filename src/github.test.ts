import { describe, it, expect, vi } from 'vitest';

// Deliberate, narrow exception to this repo's "github.ts has no test file"
// convention: isExternalReviewable is pure logic with no `gh` shelling, and
// it is the only guard keeping ronin from auto-reviewing its own PRs and
// other people's drafts — see final review Fix 6. Nothing else in github.ts
// is tested here.
vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
  LABEL_MANAGED: 'ronin',
  LABEL_STATES: [],
  LABEL_BUG: 'bugfix',
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));

const { isExternalReviewable } = await import('./github.js');

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
