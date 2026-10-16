import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySignature, scopeForEvent } from './events.js';

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

describe('scopeForEvent', () => {
  const tracked = ['acme/product'];
  const repository = { full_name: 'acme/product' };
  const slicePr = { number: 40, head: { ref: 'ronin/12/slice-2' } };
  const externalPr = { number: 41, head: { ref: 'feature/x' } };

  it('starts an assigned issue, scoped to that issue', () => {
    expect(scopeForEvent('issues', { action: 'assigned', issue: { number: 7 }, repository }, tracked)).toEqual({
      repo: 'acme/product',
      scope: { flows: ['assign', 'issues'], resources: ['issue-7'] },
    });
  });

  it("scopes an event on a slice PR to the PR and its issue, whose job holds the whole stack", () => {
    expect(scopeForEvent('pull_request', { action: 'synchronize', pull_request: slicePr, repository }, tracked)?.scope.resources).toEqual(['pr-40', 'issue-12']);
  });

  it('scopes an event on a PR ronin does not manage to that PR alone', () => {
    expect(scopeForEvent('pull_request', { action: 'opened', pull_request: externalPr, repository }, tracked)?.scope).toEqual({
      flows: ['issues', 'review', 'exploration'],
      resources: ['pr-41'],
    });
  });

  it('hands a spec PR assignment or a PR marked ready to the assignment flow', () => {
    for (const action of ['assigned', 'ready_for_review']) {
      expect(scopeForEvent('pull_request', { action, pull_request: externalPr, repository }, tracked)?.scope.flows).toEqual(['assign', 'issues', 'review']);
    }
  });

  it('cleans up after a closed or merged PR, and lets a PR stacked on it auto-merge', () => {
    expect(scopeForEvent('pull_request', { action: 'closed', pull_request: slicePr, repository }, tracked)?.scope.flows).toEqual(['sweeps', 'issues', 'auto-merge']);
  });

  it('reads a comment on a PR as PR activity, leaving its issue to the handler', () => {
    expect(scopeForEvent('issue_comment', { action: 'created', issue: { number: 40, pull_request: {} }, repository }, tracked)?.scope).toEqual({
      flows: ['issues', 'idle-commands', 'review', 'exploration'],
      resources: ['pr-40'],
    });
  });

  it('reads a comment on an issue only as a command on it', () => {
    expect(scopeForEvent('issue_comment', { action: 'created', issue: { number: 9 }, repository }, tracked)?.scope).toEqual({
      flows: ['issue-commands'],
      resources: ['issue-9'],
    });
  });

  it('reads a new inline review comment and a submitted review as PR activity', () => {
    expect(scopeForEvent('pull_request_review_comment', { action: 'created', pull_request: slicePr, repository }, tracked)?.scope.flows).toEqual(['issues', 'idle-commands', 'review', 'exploration']);
    expect(scopeForEvent('pull_request_review', { action: 'submitted', pull_request: slicePr, repository }, tracked)?.scope.flows).toEqual(['auto-merge', 'issues', 'idle-commands', 'review', 'exploration']);
  });

  it('ignores a review being edited or dismissed, and an edited comment', () => {
    expect(scopeForEvent('pull_request_review', { action: 'edited', pull_request: slicePr, repository }, tracked)).toBeNull();
    expect(scopeForEvent('pull_request_review', { action: 'dismissed', pull_request: slicePr, repository }, tracked)).toBeNull();
    expect(scopeForEvent('issue_comment', { action: 'edited', issue: { number: 9 }, repository }, tracked)).toBeNull();
  });

  it('writes the changelog for a published (non-prerelease) release only', () => {
    expect(scopeForEvent('release', { action: 'released', repository }, tracked)?.scope).toEqual({ flows: ['changelog'], resources: ['changelog'] });
    expect(scopeForEvent('release', { action: 'published', repository }, tracked)).toBeNull();
    expect(scopeForEvent('release', { action: 'created', repository }, tracked)).toBeNull();
  });

  it('reacts when ronin:auto-merge goes on a PR, and only that label', () => {
    expect(scopeForEvent('pull_request', { action: 'labeled', label: { name: 'ronin:auto-merge' }, pull_request: slicePr, repository }, tracked)?.scope.flows).toEqual(['auto-merge']);
    expect(scopeForEvent('pull_request', { action: 'labeled', label: { name: 'ronin:attempts-2' }, pull_request: slicePr, repository }, tracked)).toBeNull();
  });

  it('scopes CI finishing to every PR of the suite, and ignores a branch without one', () => {
    expect(scopeForEvent('check_suite', { action: 'completed', check_suite: { pull_requests: [slicePr, externalPr] }, repository }, tracked)?.scope).toEqual({
      flows: ['auto-merge', 'issues'],
      resources: ['pr-40', 'issue-12', 'pr-41'],
    });
    expect(scopeForEvent('check_suite', { action: 'completed', check_suite: { pull_requests: [] }, repository }, tracked)).toBeNull();
    expect(scopeForEvent('check_suite', { action: 'requested', check_suite: { pull_requests: [slicePr] }, repository }, tracked)).toBeNull();
  });

  it('ignores a repo not in repos.json, a payload with no repository, the ping event and irrelevant events', () => {
    expect(scopeForEvent('issues', { action: 'assigned', issue: { number: 7 }, repository: { full_name: 'someone-else/other' } }, tracked)).toBeNull();
    expect(scopeForEvent('issues', { action: 'assigned', issue: { number: 7 } }, tracked)).toBeNull();
    expect(scopeForEvent('ping', { repository }, tracked)).toBeNull();
    expect(scopeForEvent('push', { repository }, tracked)).toBeNull();
    expect(scopeForEvent('issues', { action: 'labeled', issue: { number: 7 }, repository }, tracked)).toBeNull();
  });
});
