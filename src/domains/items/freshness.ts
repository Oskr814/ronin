import { expireExploration } from '../explorations/review.js';
import { expireDetails } from './detail.js';
import { expireFiles, expireReviewsOf } from './files.js';
import { expireGithub } from './github.js';

// What GitHub tells the webhook server (#368), on the dashboard's caches:
// the server and the dashboard are one process, so a webhook about an issue
// or a PR reads again whatever someone has open of it — its page, its
// files, its findings, and the repo for the sidebar — instead of waiting for
// the TTL. Nobody waits for those reads: what's there is served meanwhile.
// Something nobody has open is only marked stale, for its next request.

export interface GithubChange {
  repo: string;
  numbers: number[];
  // What of it changed: the sidebar's (state, labels, checks, reviews), an
  // item's page (its conversation), its PR's files and threads, everyone's
  // own (a review submitted).
  sidebar: boolean;
  page: boolean;
  files: boolean;
  reviews: boolean;
}

interface Payload {
  repository?: { full_name?: string };
  issue?: { number?: number };
  pull_request?: { number?: number };
  check_suite?: { pull_requests?: Array<{ number?: number }> };
}

// What each event changes of what the dashboard shows.
const CHANGES: Record<string, Omit<GithubChange, 'repo' | 'numbers'>> = {
  issues: { sidebar: true, page: true, files: false, reviews: false },
  pull_request: { sidebar: true, page: true, files: true, reviews: false },
  issue_comment: { sidebar: false, page: true, files: false, reviews: false },
  pull_request_review: { sidebar: true, page: true, files: true, reviews: true },
  pull_request_review_comment: { sidebar: false, page: true, files: true, reviews: false },
  check_suite: { sidebar: true, page: false, files: false, reviews: false },
};

export function githubChangeOf(eventName: string, payload: Payload, trackedRepos: string[]): GithubChange | null {
  const repo = payload.repository?.full_name;
  const changes = CHANGES[eventName];
  if (!repo || !changes || !trackedRepos.includes(repo)) return null;
  const numbers = [payload.issue?.number, payload.pull_request?.number, ...(payload.check_suite?.pull_requests ?? []).map((pr) => pr.number)]
    .filter((n): n is number => typeof n === 'number');
  return { repo, numbers: [...new Set(numbers)], ...changes };
}

export function applyGithubChange(change: GithubChange): void {
  if (change.sidebar) expireGithub(change.repo);
  for (const n of change.numbers) {
    if (change.page) expireDetails(change.repo, n);
    if (change.files) {
      expireFiles(change.repo, n);
      expireExploration(change.repo, n);
    }
    if (change.reviews) expireReviewsOf(change.repo, n);
  }
}
