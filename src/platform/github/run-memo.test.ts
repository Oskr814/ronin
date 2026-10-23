import { describe, it, expect, vi } from 'vitest';
import { forgetGithubMemo, ghWrites, inGithubMemo, memoized, remember, withGithubMemo } from './run-memo.js';

// #370: a tick's run reads the open PRs once and its steps share them.
describe('the memo of a run', () => {
  it('reads once per key inside a run, and every time outside of one', async () => {
    const read = vi.fn(async () => ['#1']);
    await withGithubMemo(async () => {
      expect(inGithubMemo()).toBe(true);
      await Promise.all([memoized('open-prs', read), memoized('open-prs', read)]);
      await memoized('open-prs', read);
    });
    expect(read).toHaveBeenCalledTimes(1);

    expect(inGithubMemo()).toBe(false);
    await memoized('open-prs', read);
    await memoized('open-prs', read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps two runs apart, like two repos ticking at once', async () => {
    const read = vi.fn(async () => []);
    await Promise.all([withGithubMemo(() => memoized('open-prs', read)), withGithubMemo(() => memoized('open-prs', read))]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again after a write, after a failed read, and once it is older than two minutes', async () => {
    const read = vi.fn(async () => []);
    await withGithubMemo(async () => {
      await memoized('open-prs', read);
      forgetGithubMemo();
      await memoized('open-prs', read);
      expect(read).toHaveBeenCalledTimes(2);

      await memoized('open-prs', read, Date.now() + 3 * 60 * 1000);
      expect(read).toHaveBeenCalledTimes(3);
    });

    const failing = vi.fn().mockRejectedValueOnce(new Error('gh: HTTP 502')).mockResolvedValue(['#1']);
    await withGithubMemo(async () => {
      await expect(memoized('open-prs', failing)).rejects.toThrow('HTTP 502');
      await expect(memoized('open-prs', failing)).resolves.toEqual(['#1']);
    });
  });
});

describe('what another read already brought', () => {
  it('is served as if it had been read, until a write; outside a run it keeps nothing', async () => {
    const read = vi.fn(async () => 'leído');
    await withGithubMemo(async () => {
      remember('issue-body-7', 'del listado');
      expect(await memoized('issue-body-7', read)).toBe('del listado');
      forgetGithubMemo();
      expect(await memoized('issue-body-7', read)).toBe('leído');
    });
    remember('issue-body-7', 'del listado');
    expect(await memoized('issue-body-7', read)).toBe('leído');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('which gh commands write', () => {
  it('reads with list, view and checks; writes with everything else on a PR or an issue', () => {
    expect(ghWrites(['pr', 'list', '--state', 'open'])).toBe(false);
    expect(ghWrites(['issue', 'view', '12', '--json', 'body'])).toBe(false);
    expect(ghWrites(['pr', 'checks', '12'])).toBe(false);
    expect(ghWrites(['pr', 'merge', '12', '--squash'])).toBe(true);
    expect(ghWrites(['issue', 'edit', '12', '--add-label', 'ronin:in-progress'])).toBe(true);
    expect(ghWrites(['pr', 'comment', '12', '--body', 'x'])).toBe(true);
  });

  it('lets ensureLabel create a label without forgetting the open PRs', () => {
    expect(ghWrites(['label', 'create', 'ronin:auto-merge', '--force'])).toBe(false);
    expect(ghWrites(['label', 'delete', 'x'])).toBe(true);
  });

  it('reads gh api by its method: GET unless -X says otherwise or there are fields', () => {
    expect(ghWrites(['api', 'repos/acme/tienda/pulls/12/reviews', '--paginate'])).toBe(false);
    expect(ghWrites(['api', '-X', 'GET', 'repos/acme/tienda/issues/comments', '-f', 'since=2026-10-23T00:00:00Z'])).toBe(false);
    expect(ghWrites(['api', '--method', 'PATCH', 'repos/acme/tienda/pulls/12', '-f', 'base=main'])).toBe(true);
    expect(ghWrites(['api', 'repos/acme/tienda/issues/12/comments', '-f', 'body=hola'])).toBe(true);
    expect(ghWrites(['api', '--method', 'POST', 'repos/acme/tienda/pulls/12/reviews', '--input', '/tmp/r.json'])).toBe(true);
  });

  it('writes with GraphQL only through a mutation', () => {
    expect(ghWrites(['api', 'graphql', '-f', 'query=\n  query($owner: String!) { repository(owner: $owner) { id } }', '-f', 'owner=acme'])).toBe(false);
    expect(ghWrites(['api', 'graphql', '-f', 'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'])).toBe(true);
  });
});
