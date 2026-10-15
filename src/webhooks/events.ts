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

// config.ts's LABEL_AUTO_MERGE — not imported: this module stays free of
// config.ts, which requires the runner's env vars just to load.
const LABEL_AUTO_MERGE = 'ronin:auto-merge';

// Event/action combos that actually move the needle for tick()'s three
// discovery paths (see docs — assignment, external-PR review, mentions/
// commands). Everything else (push, label, etc.) is noise we don't need to
// wake a tick up for.
const RELEVANT: Record<string, string[]> = {
  issues: ['assigned'],
  // "closed" covers a merge too: the merged slice is checked off, its stack
  // retargeted, and its worktree and /preview taken down right away instead
  // of on the next cron tick.
  pull_request: ['assigned', 'ready_for_review', 'opened', 'synchronize', 'reopened', 'closed'],
  issue_comment: ['created'],
  pull_request_review_comment: ['created'],
  // An approval (an exploration PR merges on it) or a request for changes
  // with no inline comment wouldn't wake a tick otherwise.
  pull_request_review: ['submitted'],
  // CI finishing on a PR: one with ronin:auto-merge merges right then
  // instead of on the next cron tick (auto-merge.ts).
  check_suite: ['completed'],
  // GitHub's "released" action fires only for a real, non-draft,
  // non-prerelease publish — unlike "published" (fires for pre-releases too)
  // or "created" (fires for drafts). Exactly the trigger changelog.ts wants;
  // see docs on the release event's action types.
  release: ['released'],
};

// `payload` is untyped GitHub webhook JSON on purpose — we only ever read a
// couple of well-known fields off it, never trust it for anything beyond
// "is this worth waking a tick up for". The actual work still re-reads fresh
// state from GitHub inside tick() itself.
export function shouldTriggerTick(
  eventName: string,
  payload: { action?: string; repository?: { full_name?: string }; label?: { name?: string }; check_suite?: { pull_requests?: unknown[] } },
  trackedRepos: string[],
): boolean {
  const repo = payload.repository?.full_name;
  if (!repo || !trackedRepos.includes(repo)) return false;
  // Only ronin:auto-merge going on (by hand or by /auto-merge): ronin changes
  // other labels on its own PRs during a tick, and each of those would wake
  // another one.
  if (eventName === 'pull_request' && payload.action === 'labeled') return payload.label?.name === LABEL_AUTO_MERGE;
  // A suite on a branch with no PR (a push to main) has nothing to merge.
  if (eventName === 'check_suite' && (payload.check_suite?.pull_requests?.length ?? 0) === 0) return false;

  const actions = RELEVANT[eventName];
  if (!actions) return false;
  return payload.action !== undefined && actions.includes(payload.action);
}
