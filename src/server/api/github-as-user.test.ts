import { describe, it, expect, vi, afterEach } from 'vitest';
import { addReviewThread, approvePr, closeIssue, closePr, commentOnDiff, pendingReview, submitReview, commentOnFile, commentOnIssue, GithubUserError, replyToReviewComment, setFileViewed, setThreadResolved, viewedFiles } from './github-as-user.js';

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

  it('closes a PR, and an issue as not planned (#195)', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { html_url: 'https://github.com/acme/product/pull/918' })).mockResolvedValueOnce(reply(200, { html_url: 'https://github.com/acme/product/issues/912' }));
    expect(await closePr('gho_user', 'acme/product', 918)).toEqual({ url: 'https://github.com/acme/product/pull/918' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/product/pulls/918');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ state: 'closed' });
    await closeIssue('gho_user', 'acme/product', 912);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/product/issues/912');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ state: 'closed', state_reason: 'not_planned' });
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

  it('comments a range of the diff on the commit the person saw, or the whole file (#111)', async () => {
    fetchMock.mockImplementation(async () => reply(201, { id: 9, html_url: 'u' }));
    const sha = 'a'.repeat(40);
    await commentOnDiff('gho_user', 'acme/product', 904, { path: 'src/a.ts', commitId: sha, subject: 'line', side: 'RIGHT', line: 15, startLine: 14 }, 'mejor así');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/product/pulls/904/comments');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ body: 'mejor así', commit_id: sha, path: 'src/a.ts', line: 15, side: 'RIGHT', start_line: 14, start_side: 'RIGHT' });
    await commentOnDiff('gho_user', 'acme/product', 904, { path: 'src/a.ts', commitId: sha, subject: 'line', side: 'LEFT', line: 3, startLine: 3 }, 'x');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ body: 'x', commit_id: sha, path: 'src/a.ts', line: 3, side: 'LEFT' });
    await commentOnDiff('gho_user', 'acme/product', 904, { path: 'src/a.ts', commitId: sha, subject: 'file' }, 'y');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ body: 'y', commit_id: sha, path: 'src/a.ts', subject_type: 'file' });
  });

  it('replies in a thread', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { id: 10, html_url: 'u' }));
    await replyToReviewComment('gho_user', 'acme/product', 904, 77, 'ok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/product/pulls/904/comments/77/replies');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ body: 'ok' });
  });

  it('says what a 422 was about', async () => {
    fetchMock.mockResolvedValueOnce(reply(422, { message: 'Validation Failed', errors: ['pull_request_review_thread.line must be part of the diff'] }));
    await expect(replyToReviewComment('gho_user', 'acme/product', 904, 77, 'ok')).rejects.toThrow('must be part of the diff');
  });

  it('resolves and reopens a thread, and marks a file viewed, through GraphQL', async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: {} }));
    await setThreadResolved('gho_user', 'acme/product', 'PRRT_1', true);
    await setThreadResolved('gho_user', 'acme/product', 'PRRT_1', false);
    await setFileViewed('gho_user', 'acme/product', 'PR_1', 'src/a.ts', true);
    const sent = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
    expect(sent[0][0]).toBe('https://api.github.com/graphql');
    expect(sent[0][1].query).toContain('resolveReviewThread');
    expect(sent[0][1].variables).toEqual({ id: 'PRRT_1' });
    expect(sent[1][1].query).toContain('unresolveReviewThread');
    expect(sent[2][1].query).toContain('markFileAsViewed');
    expect(sent[2][1].variables).toEqual({ id: 'PR_1', path: 'src/a.ts' });
  });

  it('reads the files the person viewed, page by page, and turns GraphQL errors into refusals', async () => {
    const page = (nodes: unknown[], next: string | null) => reply(200, { data: { repository: { pullRequest: { files: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } } } });
    fetchMock.mockResolvedValueOnce(page([{ path: 'a', viewerViewedState: 'VIEWED' }, { path: 'b', viewerViewedState: 'DISMISSED' }], 'c1')).mockResolvedValueOnce(page([{ path: 'c', viewerViewedState: 'VIEWED' }], null));
    expect(await viewedFiles('gho_user', 'acme/product', 904)).toEqual(['a', 'c']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.after).toBe('c1');
    fetchMock.mockResolvedValueOnce(reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }));
    await expect(setThreadResolved('gho_user', 'acme/product', 'PRRT_1', true)).rejects.toThrow('no te deja');
    fetchMock.mockResolvedValueOnce(reply(401, {}));
    await expect(setThreadResolved('gho_user', 'acme/product', 'PRRT_1', true)).rejects.toMatchObject({ relogin: true });
  });

  it("reads the person's pending review from the PR's threads: what it starts and what it replies", async () => {
    const thread = (id: string, states: string[]) => ({ id, path: 'src/a.ts', subjectType: 'LINE', diffSide: 'RIGHT', line: 3, startLine: null, originalLine: 3, comments: { nodes: states.map((state, i) => ({ id: `${id}-c${i}`, databaseId: i, body: state, createdAt: '', state })) } });
    fetchMock.mockResolvedValueOnce(reply(200, { data: { repository: { pullRequest: {
      reviews: { nodes: [{ id: 'PRR_x', viewerDidAuthor: false }, { id: 'PRR_mine', viewerDidAuthor: true }] },
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread('T1', ['SUBMITTED']), thread('T2', ['SUBMITTED', 'PENDING']), thread('T3', ['PENDING'])] },
    } } } }));
    const review = await pendingReview('gho_user', 'acme/product', 904);
    expect(review?.id).toBe('PRR_mine');
    expect(review?.threads.map((t) => [t.id, t.isNew, t.comments.map((c) => c.nodeId)])).toEqual([['T2', false, ['T2-c1']], ['T3', true, ['T3-c0']]]);
    fetchMock.mockResolvedValueOnce(reply(200, { data: { repository: { pullRequest: { reviews: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
    expect(await pendingReview('gho_user', 'acme/product', 904)).toBeNull();
  });

  it('adds a range to the review, and submits it or a review of its own', async () => {
    fetchMock.mockImplementation(async () => reply(200, { data: { submitPullRequestReview: { pullRequestReview: { url: 'u1' } }, addPullRequestReview: { pullRequestReview: { url: 'u2' } } } }));
    await addReviewThread('gho_user', 'acme/product', 'PRR_1', { path: 'a.ts', commitId: 'c', subject: 'line', side: 'LEFT', line: 9, startLine: 7 }, 'x');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.input).toEqual({ pullRequestReviewId: 'PRR_1', path: 'a.ts', body: 'x', subjectType: 'LINE', line: 9, side: 'LEFT', startLine: 7, startSide: 'LEFT' });
    expect(await submitReview('gho_user', 'acme/product', { prId: 'PR_1', commitId: 'c', pendingId: 'PRR_1', event: 'APPROVE', body: '' })).toEqual({ url: 'u1' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables).toEqual({ id: 'PRR_1', event: 'APPROVE', body: null });
    expect(await submitReview('gho_user', 'acme/product', { prId: 'PR_1', commitId: 'c', event: 'REQUEST_CHANGES', body: 'no' })).toEqual({ url: 'u2' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).variables).toEqual({ pr: 'PR_1', commit: 'c', event: 'REQUEST_CHANGES', body: 'no' });
  });
});
