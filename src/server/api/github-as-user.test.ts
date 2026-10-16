import { describe, it, expect, vi, afterEach } from 'vitest';
import { approvePr, commentOnFile, commentOnIssue, GithubUserError } from './github-as-user.js';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('github-as-user', () => {
  it('comments on an issue with the person’s token', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { id: 5, html_url: 'https://github.com/acme/product/pull/849#issuecomment-5' }));
    expect(await commentOnIssue('gho_user', 'acme/product', 849, '@ronin-agent /preview')).toEqual({ id: 5, url: 'https://github.com/acme/product/pull/849#issuecomment-5' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/product/issues/849/comments');
    expect(init.headers.Authorization).toBe('Bearer gho_user');
    expect(JSON.parse(init.body)).toEqual({ body: '@ronin-agent /preview' });
  });

  it('comments on a whole file of the PR, at its current head', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { head: { sha: 'abc123' } })).mockResolvedValueOnce(reply(201, { id: 9, html_url: 'u' }));
    await commentOnFile('gho_user', 'acme/product', 840, 'docs/exploration/backoffice/findings/F-0017-x.md', 'Rechazo esta ficha: no');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/product/pulls/840/comments');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ body: 'Rechazo esta ficha: no', commit_id: 'abc123', path: 'docs/exploration/backoffice/findings/F-0017-x.md', subject_type: 'file' });
  });

  it('approves the PR with a review, as GitHub’s Review changes does', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 3, html_url: 'https://github.com/acme/product/pull/840#pullrequestreview-3' }));
    await approvePr('gho_user', 'acme/product', 840, 'dale');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/product/pulls/840/reviews');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ event: 'APPROVE', body: 'dale' });
  });

  it('asks to log in again for a token GitHub no longer takes, and explains a refusal', async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { message: 'Bad credentials' }));
    await expect(commentOnIssue('gho_viejo', 'acme/product', 1, 'x')).rejects.toMatchObject({ relogin: true });
    fetchMock.mockResolvedValueOnce(reply(403, { message: 'Although you appear to have the correct authorization credentials, the organization has enabled OAuth App access restrictions' }));
    const error = await commentOnIssue('gho_user', 'acme/product', 1, 'x').catch((e) => e);
    expect(error).toBeInstanceOf(GithubUserError);
    expect(error.relogin).toBe(false);
    expect(error.message).toContain('acme/product');
    expect(error.message).toContain('aprobar el tablero');
  });
});
