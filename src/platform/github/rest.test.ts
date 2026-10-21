import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubFetch, parseRepo } from './rest.js';

afterEach(() => vi.unstubAllGlobals());

describe('githubFetch', () => {
  it('sends the token, the API version and a JSON body', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await githubFetch('/repos/acme/tienda/issues/1/comments', { token: 't0k', method: 'POST', body: { body: 'hola' } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/repos/acme/tienda/issues/1/comments');
    expect(init).toMatchObject({ method: 'POST', body: '{"body":"hola"}' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t0k', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('takes a whole Authorization header, and sends no body or content type without one', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await githubFetch('/user', { authorization: 'Basic abc' });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Basic abc');
    expect(init.headers['Content-Type']).toBeUndefined();
  });
});

describe('parseRepo', () => {
  it('splits owner/name', () => {
    expect(parseRepo('acme/tienda')).toEqual({ owner: 'acme', name: 'tienda' });
    expect(parseRepo('acme')).toEqual({ owner: 'acme', name: '' });
  });
});
