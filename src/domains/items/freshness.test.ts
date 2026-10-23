import { describe, it, expect, vi } from 'vitest';

const expired: string[] = [];
vi.mock('./github.js', () => ({ expireGithub: (repo: string) => expired.push(`repo ${repo}`) }));
vi.mock('./detail.js', () => ({ expireDetails: (repo: string, n: number) => expired.push(`page ${repo}#${n}`) }));
vi.mock('./files.js', () => ({ expireFiles: (repo: string, n: number) => expired.push(`files ${repo}#${n}`), expireReviewsOf: (repo: string, n: number) => expired.push(`mine ${repo}#${n}`) }));
vi.mock('../explorations/review.js', () => ({ expireExploration: (repo: string, n: number) => expired.push(`exploration ${repo}#${n}`) }));

const { applyGithubChange, githubChangeOf } = await import('./freshness.js');

const TRACKED = ['acme/tienda'];
const repository = { full_name: 'acme/tienda' };

// #368: a webhook reads again what the dashboard has open of what it's about.
describe('what a webhook changes on the dashboard', () => {
  it('a comment: only the page of its issue or PR', () => {
    expect(githubChangeOf('issue_comment', { repository, issue: { number: 7 } }, TRACKED)).toEqual({ repo: 'acme/tienda', numbers: [7], sidebar: false, page: true, files: false, reviews: false });
  });

  it('a review: the sidebar, the page, the files and everyone\'s own', () => {
    expired.length = 0;
    applyGithubChange(githubChangeOf('pull_request_review', { repository, pull_request: { number: 12 } }, TRACKED)!);
    expect(expired).toEqual(['repo acme/tienda', 'page acme/tienda#12', 'files acme/tienda#12', 'exploration acme/tienda#12', 'mine acme/tienda#12']);
  });

  it('a check suite: the sidebar, for each of its PRs', () => {
    expect(githubChangeOf('check_suite', { repository, check_suite: { pull_requests: [{ number: 12 }, { number: 13 }, { number: 12 }] } }, TRACKED))
      .toMatchObject({ numbers: [12, 13], sidebar: true, page: false });
  });

  it('nothing for another repo, or an event the dashboard does not show', () => {
    expect(githubChangeOf('issues', { repository: { full_name: 'otra/cosa' }, issue: { number: 1 } }, TRACKED)).toBeNull();
    expect(githubChangeOf('release', { repository }, TRACKED)).toBeNull();
    expect(githubChangeOf('workflow_run', { repository }, TRACKED)).toBeNull();
  });
});
