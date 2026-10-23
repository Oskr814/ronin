import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiRequestOf, callGithubApi, GithubApiError, nextPageOf } from './gh-api.js';

// #370: `gh api` sent with fetch, from the same arguments.
describe('the request of a gh api call', () => {
  it('reads with GET, and sends its fields in the query', () => {
    expect(apiRequestOf(['api', 'repos/acme/tienda/issues/7'])).toEqual({ method: 'GET', path: '/repos/acme/tienda/issues/7', headers: {} });
    expect(apiRequestOf(['api', '-X', 'GET', 'repos/acme/tienda/issues/comments?per_page=100', '-f', 'since=2026-10-23T00:00:00Z'])).toEqual({
      method: 'GET', path: '/repos/acme/tienda/issues/comments?per_page=100&since=2026-10-23T00%3A00%3A00Z', headers: {},
    });
  });

  it('writes with POST once there are fields, typing -F like gh does', () => {
    expect(apiRequestOf(['api', '-X', 'POST', 'repos/acme/tienda/pulls', '-f', 'head=ronin/7/slice-1', '-f', 'title=Una slice', '-F', 'draft=true'])).toEqual({
      method: 'POST', path: '/repos/acme/tienda/pulls', headers: {}, body: { head: 'ronin/7/slice-1', title: 'Una slice', draft: true },
    });
    expect(apiRequestOf(['api', 'repos/acme/tienda/issues/7/comments', '-f', 'body=hola = chau'])).toEqual({
      method: 'POST', path: '/repos/acme/tienda/issues/7/comments', headers: {}, body: { body: 'hola = chau' },
    });
    expect(apiRequestOf(['api', '--method', 'PATCH', 'repos/acme/tienda/issues/7', '-f', 'state=closed', '-f', 'state_reason=not_planned'])?.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('makes a list of the fields that end in []', () => {
    expect(apiRequestOf(['api', '-X', 'POST', 'repos/acme/tienda/issues/7/assignees', '-f', 'assignees[]=ana', '-f', 'assignees[]=beto'])?.body).toEqual({ assignees: ['ana', 'beto'] });
  });

  it('sends GraphQL its query and the rest as variables, numbers as numbers', () => {
    expect(apiRequestOf(['api', 'graphql', '-f', 'query=query($n: Int!) { x }', '-f', 'owner=acme', '-F', 'number=12', '-f', 'states[]=OPEN'])).toEqual({
      method: 'POST', path: '/graphql', headers: {}, body: { query: 'query($n: Int!) { x }', variables: { owner: 'acme', number: 12, states: ['OPEN'] } },
    });
  });

  it('takes the body from --input, and its headers from -H', () => {
    expect(apiRequestOf(['api', '--method', 'POST', 'repos/acme/tienda/pulls/12/reviews', '--input', '/tmp/r.json'])).toEqual({
      method: 'POST', path: '/repos/acme/tienda/pulls/12/reviews', headers: {}, inputFile: '/tmp/r.json',
    });
    expect(apiRequestOf(['api', 'repos/acme/tienda/contents/a.ts?ref=abc', '-H', 'Accept: application/vnd.github.raw'])?.headers).toEqual({ Accept: 'application/vnd.github.raw' });
  });

  it('leaves to gh what it does not understand', () => {
    expect(apiRequestOf(['api', 'repos/acme/tienda/pulls/12', '--jq', '.head.sha'])).toBeNull();
    expect(apiRequestOf(['api', '--paginate', 'repos/acme/tienda/pulls/12/files'])).toBeNull();
    expect(apiRequestOf(['api', 'repos/acme/tienda/issues/7/comments', '-F', 'body=@/tmp/body.md'])).toBeNull();
    expect(apiRequestOf(['api', 'repos/acme/tienda/issues/7', '-f', 'a[b]=c'])).toBeNull();
    expect(apiRequestOf(['pr', 'list'])).toBeNull();
  });
});

describe('the next page', () => {
  it('is the Link header\'s rel="next", or none', () => {
    expect(nextPageOf('<https://api.github.com/repositories/1/issues/comments?page=2>; rel="next", <https://api.github.com/repositories/1/issues/comments?page=5>; rel="last"')).toBe('https://api.github.com/repositories/1/issues/comments?page=2');
    expect(nextPageOf('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextPageOf(null)).toBeNull();
  });
});

describe('a call', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));

  it('gives back the body as gh printed it, with the token and the JSON body', async () => {
    const fetch = answer(201, { id: 9 });
    vi.stubGlobal('fetch', fetch);
    const out = await callGithubApi({ method: 'POST', path: '/repos/acme/tienda/issues/7/comments', headers: {}, body: { body: 'hola' } }, 'tkn', 'op');
    expect(JSON.parse(out.text)).toEqual({ id: 9 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/tienda/issues/7/comments');
    expect(init.body).toBe('{"body":"hola"}');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tkn');
  });

  it('fails worded like gh, so a 404 still means none and a 502 is still transient', async () => {
    vi.stubGlobal('fetch', answer(404, { message: 'Not Found' }));
    await expect(callGithubApi({ method: 'GET', path: '/repos/acme/tienda/issues/9', headers: {} }, 't', 'op')).rejects.toThrow(/Not Found \(HTTP 404\)/);
    vi.stubGlobal('fetch', answer(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }));
    await expect(callGithubApi({ method: 'POST', path: '/repos/acme/tienda/pulls', headers: {} }, 't', 'op')).rejects.toThrow('Validation Failed; A pull request already exists (HTTP 422)');
    vi.stubGlobal('fetch', answer(502, '<html>Bad Gateway</html>'));
    const error = await callGithubApi({ method: 'GET', path: '/x', headers: {} }, 't', 'op').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubApiError);
    expect((error as GithubApiError).status).toBe(502);
  });

  it('fails on GraphQL errors, like gh, even with data', async () => {
    vi.stubGlobal('fetch', answer(200, { data: { repository: null }, errors: [{ message: 'Could not resolve to a Repository' }] }));
    await expect(callGithubApi({ method: 'POST', path: '/graphql', headers: {}, body: { query: '{}' } }, 't', 'op')).rejects.toThrow('GraphQL: Could not resolve to a Repository');
  });

  it('says the network code of a failed connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }));
    await expect(callGithubApi({ method: 'GET', path: '/x', headers: {} }, 't', 'op')).rejects.toThrow('fetch failed (ECONNRESET)');
  });

  it('gives the next page from Link', async () => {
    vi.stubGlobal('fetch', answer(200, [], { link: '<https://api.github.com/x?page=2>; rel="next"' }));
    expect((await callGithubApi({ method: 'GET', path: '/x', headers: {} }, 't', 'op')).next).toBe('https://api.github.com/x?page=2');
  });
});
