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

import type { Flow, Scope } from '../tick/tick.js';

// config.ts's LABEL_AUTO_MERGE — not imported: this module stays free of
// config.ts, which requires the runner's env vars just to load.
const LABEL_AUTO_MERGE = 'ronin:auto-merge';

// The flows each event/action can move — tick.ts runs only those, and only
// for the event's issue or PR (see Scope). Everything else (push, label,
// etc.) is noise nothing reacts to.
const PR_ACTIVITY: Flow[] = ['issues', 'idle-commands', 'review', 'exploration'];
const FLOWS: Record<string, Record<string, Flow[]>> = {
  // A portal request's issue closing tells the person (#114).
  issues: { assigned: ['assign', 'issues'], closed: ['portal'] },
  pull_request: {
    // A spec PR handed to ronin, a slice PR out of draft, an external PR
    // ready for review.
    assigned: ['assign', 'issues', 'review'],
    ready_for_review: ['assign', 'issues', 'review'],
    // An approved portal request's PR gets ronin:auto-merge right away, and
    // so does ronin's own slice PR (auto-merge.ts's labelNewSlicePrs).
    opened: ['issues', 'review', 'exploration', 'portal', 'auto-merge'],
    // A new commit also moves the PR's /preview to it.
    synchronize: ['previews', 'issues', 'review', 'exploration'],
    reopened: ['issues', 'review', 'exploration'],
    // A merge too: the merged slice is checked off, its stack retargeted,
    // its worktree and /preview taken down, and a PR stacked on it can
    // auto-merge now. A portal request's merge tells the person.
    closed: ['sweeps', 'issues', 'auto-merge', 'portal'],
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
  // A release's workflow ending: a deploy ronin published is done (#158).
  workflow_run: { completed: ['deploys'] },
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
  sender?: { login?: string };
  comment?: { id?: number; body?: string };
  repository?: { full_name?: string };
  label?: { name?: string };
  issue?: { number?: number; pull_request?: unknown };
  pull_request?: PrRef;
  check_suite?: { pull_requests?: PrRef[] };
  workflow_run?: { event?: string };
}

function prResources(pr: PrRef): string[] {
  if (typeof pr.number !== 'number') return [];
  const issue = pr.head?.ref?.match(RONIN_BRANCH_RE)?.[1];
  return [`pr-${pr.number}`, ...(issue ? [`issue-${issue}`] : [])];
}

function resourcesOf(eventName: string, payload: EventPayload): string[] {
  if (eventName === 'release') return ['changelog'];
  // A deploy runs on a tag push or on a release; a PR's CI is none of ronin's deploys.
  if (eventName === 'workflow_run') return ['push', 'release'].includes(payload.workflow_run?.event ?? '') ? ['deploys'] : [];
  if (eventName === 'check_suite') return (payload.check_suite?.pull_requests ?? []).flatMap(prResources);
  if (payload.pull_request) return prResources(payload.pull_request);
  const number = payload.issue?.number;
  if (typeof number !== 'number') return [];
  // A comment on a PR comes as issue_comment, without its branch: the
  // handler looks the PR's issue up itself (webhooks/handler.ts).
  return [payload.issue?.pull_request ? `pr-${number}` : `issue-${number}`];
}

// A comment that's a command — "@<login> /<something>" — other than
// /fix-comments: help, typos and misplaced commands, /preview,
// /resolve-conflicts, /auto-merge. All of them are answered or launched by
// findUnprocessedMentions alone (mentions.ts), without an agent run, so its
// handler goes straight to that and nothing else (tick.ts's 'pr-commands').
// /fix-comments does need its flow: the issue's pipeline, or the external
// PR's review.
function isQuickCommand(body: string, botLogin: string): boolean {
  // botLogin is operator config (RONIN_GITHUB_LOGIN), never comment input —
  // same reasoning as mentions.ts's mentionsHandle.
  return new RegExp(`\\B@${botLogin}\\s+/[\\w-]`, 'i').test(body) && !/\/fix-comments\b/i.test(body);
}

const COMMENT_EVENTS = ['issue_comment', 'pull_request_review_comment', 'pull_request_review'];

// Whether a delivery comes in a burst, and so waits the long debounce window
// for the rest of it (debounce.ts, #370): each workflow's check_suite and
// workflow_run come 5 to 15 s apart. Everything else — a comment, a command,
// a mention, an approval, a label — is a person waiting on ronin, and waits
// the short one, as before.
const BURST_EVENTS = new Set(['check_suite', 'workflow_run']);

export const comesInBursts = (eventName: string): boolean => BURST_EVENTS.has(eventName);

// What an event asks ronin to look at: its repo, and the Scope tick.ts's
// runScoped runs for it. Null for an event nothing reacts to — including
// ronin's own comments and reviews, which are never requests to itself.
//
// `payload` is untyped GitHub webhook JSON on purpose — we only ever read a
// couple of well-known fields off it, never trust it for anything beyond
// "what is this about". The actual work still re-reads fresh state from
// GitHub.
export function scopeForEvent(eventName: string, payload: EventPayload, trackedRepos: string[], botLogin: string): { repo: string; scope: Scope } | null {
  const repo = payload.repository?.full_name;
  if (!repo || !trackedRepos.includes(repo)) return null;
  if (COMMENT_EVENTS.includes(eventName) && payload.sender?.login?.toLowerCase() === botLogin.toLowerCase()) return null;
  // Only ronin:auto-merge going on (by hand or by /auto-merge): ronin changes
  // other labels on its own PRs as it works, and each of those would start
  // another run.
  if (eventName === 'pull_request' && payload.action === 'labeled' && payload.label?.name !== LABEL_AUTO_MERGE) return null;

  let flows = payload.action === undefined ? undefined : FLOWS[eventName]?.[payload.action];
  if (!flows) return null;
  // A comment on an issue (not a PR) can only be a command on it.
  if (eventName === 'issue_comment' && !payload.issue?.pull_request) flows = ['issue-commands'];
  else if ((eventName === 'issue_comment' || eventName === 'pull_request_review_comment') && isQuickCommand(payload.comment?.body ?? '', botLogin)) flows = ['pr-commands'];
  const resources = resourcesOf(eventName, payload);
  // A suite on a branch with no PR (a push to main) has nothing to look at.
  if (resources.length === 0) return null;
  return { repo, scope: { flows, resources } };
}

// The comment to put the "got it" 👀 on as soon as the event arrives
// (github.ts's addAckReaction): a new comment mentioning ronin, by someone
// other than ronin. Null for anything else.
export function ackTarget(eventName: string, payload: EventPayload, botLogin: string): { commentId: number; kind: 'issue' | 'review' } | null {
  if (payload.action !== 'created' || typeof payload.comment?.id !== 'number') return null;
  if (payload.sender?.login?.toLowerCase() === botLogin.toLowerCase()) return null;
  // Same rule as mentions.ts's mentionsHandle.
  if (!new RegExp(`\\B@${botLogin}\\b`, 'i').test(payload.comment.body ?? '')) return null;
  if (eventName === 'issue_comment') return { commentId: payload.comment.id, kind: 'issue' };
  if (eventName === 'pull_request_review_comment') return { commentId: payload.comment.id, kind: 'review' };
  return null;
}
