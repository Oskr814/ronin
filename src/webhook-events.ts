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

// Event/action combos that actually move the needle for tick()'s three
// discovery paths (see docs — assignment, external-PR review, mentions/
// commands). Everything else (push, label, etc.) is noise we don't need to
// wake a tick up for.
const RELEVANT: Record<string, string[]> = {
  issues: ['assigned'],
  pull_request: ['assigned', 'ready_for_review', 'opened', 'synchronize', 'reopened'],
  issue_comment: ['created'],
  pull_request_review_comment: ['created'],
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
export function shouldTriggerTick(eventName: string, payload: { action?: string; repository?: { full_name?: string } }, trackedRepos: string[]): boolean {
  const repo = payload.repository?.full_name;
  if (!repo || !trackedRepos.includes(repo)) return false;

  const actions = RELEVANT[eventName];
  if (!actions) return false;
  return payload.action !== undefined && actions.includes(payload.action);
}
