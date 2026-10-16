import { createHmac, timingSafeEqual } from 'node:crypto';

// GitHub signs the raw body with the webhook secret as `sha256=<hex>` — see
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries.
// Constant-time compare so a timing attack can't be used to guess the
// signature byte by byte.
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

import type { Flow, Scope } from '../tick.js';

// config.ts's LABEL_AUTO_MERGE — not imported: this module stays free of
// config.ts, which requires the runner's env vars just to load.
const LABEL_AUTO_MERGE = 'ronin:auto-merge';

// The flows each event/action can move — tick.ts runs only those, and only
// for the event's issue or PR (see Scope). Everything else (push, label,
// etc.) is noise nothing reacts to.
const PR_ACTIVITY: Flow[] = ['issues', 'idle-commands', 'review', 'exploration'];
const FLOWS: Record<string, Record<string, Flow[]>> = {
  issues: { assigned: ['assign', 'issues'] },
  pull_request: {
    // A spec PR handed to ronin, a slice PR out of draft, an external PR
    // ready for review.
    assigned: ['assign', 'issues', 'review'],
    ready_for_review: ['assign', 'issues', 'review'],
    opened: ['issues', 'review', 'exploration'],
    synchronize: ['issues', 'review', 'exploration'],
    reopened: ['issues', 'review', 'exploration'],
    // A merge too: the merged slice is checked off, its stack retargeted,
    // its worktree and /preview taken down, and a PR stacked on it can
    // auto-merge now.
    closed: ['sweeps', 'issues', 'auto-merge'],
    labeled: ['auto-merge'],
  },
  issue_comment: { created: PR_ACTIVITY },
  pull_request_review_comment: { created: PR_ACTIVITY },
  // An approval (an exploration PR merges on it, so does an auto-merge one)
  // or a request for changes with no inline comment.
  pull_request_review: { submitted: ['auto-merge', ...PR_ACTIVITY] },
  // CI finishing on a PR: one with ronin:auto-merge merges right then, a
  // slice with failing checks gets its fix-e2e.
  check_suite: { completed: ['auto-merge', 'issues'] },
  // GitHub's "released" action fires only for a real, non-draft,
  // non-prerelease publish — unlike "published" (fires for pre-releases too)
  // or "created" (fires for drafts). Exactly the trigger changelog.ts wants;
  // see docs on the release event's action types.
  release: { released: ['changelog'] },
};

// stack.ts's ronin/<issue>/... branches — a PR on one belongs to that
// issue's stack. Repeated here for the same reason as LABEL_AUTO_MERGE.
const RONIN_BRANCH_RE = /^ronin\/(\d+)\//;

interface PrRef {
  number?: number;
  head?: { ref?: string };
}

export interface EventPayload {
  action?: string;
  repository?: { full_name?: string };
  label?: { name?: string };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: PrRef;
  check_suite?: { pull_requests?: PrRef[] };
}

function prResources(pr: PrRef): string[] {
  if (typeof pr.number !== 'number') return [];
  const issue = pr.head?.ref?.match(RONIN_BRANCH_RE)?.[1];
  return [`pr-${pr.number}`, ...(issue ? [`issue-${issue}`] : [])];
}

function resourcesOf(eventName: string, payload: EventPayload): string[] {
  if (eventName === 'release') return ['changelog'];
  if (eventName === 'check_suite') return (payload.check_suite?.pull_requests ?? []).flatMap(prResources);
  if (payload.pull_request) return prResources(payload.pull_request);
  const number = payload.issue?.number;
  if (typeof number !== 'number') return [];
  // A comment on a PR comes as issue_comment, without its branch: the
  // handler looks the PR's issue up itself (webhooks/handler.ts).
  return [payload.issue?.pull_request ? `pr-${number}` : `issue-${number}`];
}

// What an event asks ronin to look at: its repo, and the Scope tick.ts's
// runScoped runs for it. Null for an event nothing reacts to.
//
// `payload` is untyped GitHub webhook JSON on purpose — we only ever read a
// couple of well-known fields off it, never trust it for anything beyond
// "what is this about". The actual work still re-reads fresh state from
// GitHub.
export function scopeForEvent(eventName: string, payload: EventPayload, trackedRepos: string[]): { repo: string; scope: Scope } | null {
  const repo = payload.repository?.full_name;
  if (!repo || !trackedRepos.includes(repo)) return null;
  // Only ronin:auto-merge going on (by hand or by /auto-merge): ronin changes
  // other labels on its own PRs as it works, and each of those would start
  // another run.
  if (eventName === 'pull_request' && payload.action === 'labeled' && payload.label?.name !== LABEL_AUTO_MERGE) return null;

  let flows = payload.action === undefined ? undefined : FLOWS[eventName]?.[payload.action];
  if (!flows) return null;
  // A comment on an issue (not a PR) can only be a command on it.
  if (eventName === 'issue_comment' && !payload.issue?.pull_request) flows = ['issue-commands'];
  const resources = resourcesOf(eventName, payload);
  // A suite on a branch with no PR (a push to main) has nothing to look at.
  if (resources.length === 0) return null;
  return { repo, scope: { flows, resources } };
}
