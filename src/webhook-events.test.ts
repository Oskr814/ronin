import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySignature, shouldTriggerTick } from './webhook-events.js';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, sign(body.toString()), SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, sign(body.toString(), 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a signature computed over a different body', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, sign('{"hello":"tampered"}'), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed signature header without throwing', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, 'not-a-real-signature', SECRET)).toBe(false);
  });
});

describe('shouldTriggerTick', () => {
  const trackedRepos = ['acme/product'];

  it('triggers on an issue assigned in a tracked repo', () => {
    expect(shouldTriggerTick('issues', { action: 'assigned', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a pull request assignment', () => {
    expect(shouldTriggerTick('pull_request', { action: 'assigned', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a pull request marked ready for review', () => {
    expect(shouldTriggerTick('pull_request', { action: 'ready_for_review', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a new pull request', () => {
    expect(shouldTriggerTick('pull_request', { action: 'opened', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a pull request updated with new commits', () => {
    expect(shouldTriggerTick('pull_request', { action: 'synchronize', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a new general PR comment', () => {
    expect(shouldTriggerTick('issue_comment', { action: 'created', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('triggers on a new inline review comment', () => {
    expect(shouldTriggerTick('pull_request_review_comment', { action: 'created', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(true);
  });

  it('ignores an irrelevant event type', () => {
    expect(shouldTriggerTick('push', { repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(false);
  });

  it('ignores an irrelevant action on a relevant event type', () => {
    expect(shouldTriggerTick('pull_request', { action: 'closed', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(false);
  });

  it('ignores an edited comment (not a new one)', () => {
    expect(shouldTriggerTick('issue_comment', { action: 'edited', repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(false);
  });

  it('ignores a repo not in repos.json', () => {
    expect(shouldTriggerTick('issues', { action: 'assigned', repository: { full_name: 'someone-else/other' } }, trackedRepos)).toBe(false);
  });

  it('ignores the ping event GitHub sends on webhook creation', () => {
    expect(shouldTriggerTick('ping', { repository: { full_name: 'acme/product' } }, trackedRepos)).toBe(false);
  });

  it('ignores a payload with no repository field', () => {
    expect(shouldTriggerTick('issues', { action: 'assigned' }, trackedRepos)).toBe(false);
  });
});
