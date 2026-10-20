// What the dashboard does on GitHub, done as whoever is logged in (#93):
// with the token their session carries (auth.ts), never ronin's. A comment
// written this way reaches ronin like one written on GitHub — its webhook,
// then the same handler — so nothing downstream needs to know it came from
// the dashboard.
import { timed } from '../../core/timing.js';

export interface Posted {
  id: number;
  url: string;
}

// What GitHub said no to, in words for the page. `relogin`: the token is no
// longer good (revoked, or the scope taken away), so the page asks to log in.
export class GithubUserError extends Error {
  constructor(message: string, readonly relogin = false) {
    super(message);
  }
}

const API = 'https://api.github.com';

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await timed('github', () => fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ronin-dashboard',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  if (response.ok) return (await response.json()) as T;
  // A 422 says what was wrong in `errors` (a line outside the diff), not in `message`.
  const said = await response.json().then((b: { message?: string; errors?: Array<string | { message?: string }> }) => [b?.message, ...(b?.errors ?? []).map((e) => (typeof e === 'string' ? e : e?.message))].filter(Boolean).join(': ') || undefined).catch(() => undefined);
  if (response.status === 401) throw new GithubUserError('Tu sesión de GitHub venció o se revocó. Volvé a entrar.', true);
  const repo = path.split('/').slice(2, 4).join('/');
  // An org that restricts OAuth apps answers 403, or 404 for a private repo.
  if (response.status === 403 || response.status === 404) throw new GithubUserError(`GitHub no te deja escribir en ${repo}${said ? ` (${said})` : ''}. Si la organización restringe las apps, hay que aprobar el tablero en su configuración.`);
  throw new GithubUserError(`GitHub respondió ${response.status}${said ? `: ${said}` : ''}.`);
}

export async function commentOnIssue(token: string, repo: string, number: number, body: string): Promise<Posted> {
  const created = await call<{ id: number; html_url: string }>(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
  return { id: created.id, url: created.html_url };
}

// A comment on a whole file of the PR (not a line), as GitHub's "Files
// changed" leaves one: on the PR's current head.
export async function commentOnFile(token: string, repo: string, prNumber: number, path: string, body: string): Promise<Posted> {
  const pr = await call<{ head: { sha: string } }>(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
  const created = await call<{ id: number; html_url: string }>(token, 'POST', `/repos/${repo}/pulls/${prNumber}/comments`, { body, commit_id: pr.head.sha, path, subject_type: 'file' });
  return { id: created.id, url: created.html_url };
}

// An approving review of the PR, as the person: what GitHub's "Review
// changes → Approve" sends.
export async function approvePr(token: string, repo: string, prNumber: number, body?: string): Promise<Posted> {
  const created = await call<{ id: number; html_url: string }>(token, 'POST', `/repos/${repo}/pulls/${prNumber}/reviews`, { event: 'APPROVE', ...(body ? { body } : {}) });
  return { id: created.id, url: created.html_url };
}

// Closing a PR without merging it, as the person: its branch stays (#195).
export async function closePr(token: string, repo: string, prNumber: number): Promise<{ url: string }> {
  const closed = await call<{ html_url: string }>(token, 'PATCH', `/repos/${repo}/pulls/${prNumber}`, { state: 'closed' });
  return { url: closed.html_url };
}

// Closing an issue as not planned, as the person: what GitHub's "Close as
// not planned" sends.
export async function closeIssue(token: string, repo: string, number: number): Promise<{ url: string }> {
  const closed = await call<{ html_url: string }>(token, 'PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' });
  return { url: closed.html_url };
}

// A new issue, as the person; `assignees` set at creation (ronin, to take it).
export async function createIssue(token: string, repo: string, issue: { title: string; body: string; assignees?: string[] }): Promise<{ number: number; url: string }> {
  const created = await call<{ number: number; html_url: string }>(token, 'POST', `/repos/${repo}/issues`, issue);
  return { number: created.number, url: created.html_url };
}

// Adding assignees to an issue, as the person: GitHub's "Assignees" field.
export async function assignIssue(token: string, repo: string, number: number, assignees: string[]): Promise<{ url: string }> {
  const issue = await call<{ html_url: string }>(token, 'POST', `/repos/${repo}/issues/${number}/assignees`, { assignees });
  return { url: issue.html_url };
}

// GraphQL, as the person: what REST doesn't have (resolving a thread,
// marking a file as viewed). GitHub answers 200 with `errors` when it says no.
async function graphql<T>(token: string, query: string, variables: Record<string, unknown>, repo: string): Promise<T> {
  const response = await timed('github', () => fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ronin-dashboard' },
    body: JSON.stringify({ query, variables }),
  }));
  if (response.status === 401) throw new GithubUserError('Tu sesión de GitHub venció o se revocó. Volvé a entrar.', true);
  const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string; type?: string }> };
  if (body.errors?.length) {
    const forbidden = body.errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND');
    throw new GithubUserError(forbidden ? `GitHub no te deja hacer eso en ${repo} (${body.errors[0].message}).` : `GitHub respondió: ${body.errors[0].message}`);
  }
  if (!response.ok || !body.data) throw new GithubUserError(`GitHub respondió ${response.status}.`);
  return body.data;
}

// Where a review comment goes (#111): a line or a range startLine..line on
// one side of the diff, or the whole file. On the commit the person was
// looking at, so the lines are the ones they saw.
export interface DiffSpot {
  path: string;
  commitId: string;
  subject: 'line' | 'file';
  side?: 'LEFT' | 'RIGHT';
  line?: number;
  startLine?: number;
}

export async function commentOnDiff(token: string, repo: string, prNumber: number, spot: DiffSpot, body: string): Promise<Posted> {
  const where = spot.subject === 'file'
    ? { subject_type: 'file' }
    : { line: spot.line, side: spot.side, ...(spot.startLine !== undefined && spot.startLine !== spot.line ? { start_line: spot.startLine, start_side: spot.side } : {}) };
  const created = await call<{ id: number; html_url: string }>(token, 'POST', `/repos/${repo}/pulls/${prNumber}/comments`, { body, commit_id: spot.commitId, path: spot.path, ...where });
  return { id: created.id, url: created.html_url };
}

// A reply in a review thread, to any of its comments.
export async function replyToReviewComment(token: string, repo: string, prNumber: number, commentId: number, body: string): Promise<Posted> {
  const created = await call<{ id: number; html_url: string }>(token, 'POST', `/repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, { body });
  return { id: created.id, url: created.html_url };
}

export async function setThreadResolved(token: string, repo: string, threadId: string, resolved: boolean): Promise<void> {
  const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  await graphql(token, `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, { id: threadId }, repo);
}

const VIEWED_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

// The files the person marked as viewed on the PR, as GitHub keeps them:
// one that changed since goes back to unviewed (DISMISSED).
export async function viewedFiles(token: string, repo: string, prNumber: number): Promise<string[]> {
  const [owner, name] = repo.split('/');
  type Page = { repository: { pullRequest: { files: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ path: string; viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED' }> } } } };
  const viewed: string[] = [];
  let after: string | null = null;
  do {
    const page: Page = await graphql<Page>(token, VIEWED_QUERY, { owner, repo: name, number: prNumber, after }, repo);
    const files = page.repository.pullRequest.files;
    viewed.push(...files.nodes.filter((f) => f.viewerViewedState === 'VIEWED').map((f) => f.path));
    after = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
  } while (after);
  return viewed;
}

export async function setFileViewed(token: string, repo: string, prId: string, path: string, viewed: boolean): Promise<void> {
  const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  await graphql(token, `mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: prId, path }, repo);
}

// ---------- the person's pending review (#111)
// GitHub's own draft of a review: comments that only its author sees until
// it's submitted. One per person per PR; one started on github.com is the
// same one the dashboard shows.

export interface PendingComment {
  // Its node id, which edits and deletes take; `id` is the REST one.
  nodeId: string;
  id: number;
  body: string;
  createdAt: string;
}

export interface PendingThread {
  id: string;
  path: string;
  subject: 'line' | 'file';
  side: 'LEFT' | 'RIGHT';
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  // A thread the review starts, or one of the PR's it replies in.
  isNew: boolean;
  comments: PendingComment[];
}

export interface PendingReview {
  id: string;
  threads: PendingThread[];
}

const PENDING_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(states: PENDING, first: 10) { nodes { id viewerDidAuthor } }
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path subjectType diffSide line startLine originalLine
          comments(first: 100) { nodes { id databaseId body createdAt state } }
        }
      }
    }
  }
}`;

export async function pendingReview(token: string, repo: string, prNumber: number): Promise<PendingReview | null> {
  const [owner, name] = repo.split('/');
  type Node = { id: string; path: string; subjectType: 'LINE' | 'FILE'; diffSide: 'LEFT' | 'RIGHT'; line: number | null; startLine: number | null; originalLine: number | null; comments: { nodes: Array<{ id: string; databaseId: number; body: string; createdAt: string; state: 'PENDING' | 'SUBMITTED' }> } };
  type Page = { repository: { pullRequest: { reviews: { nodes: Array<{ id: string; viewerDidAuthor: boolean }> }; reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } } };
  let review: string | undefined;
  const threads: PendingThread[] = [];
  let after: string | null = null;
  do {
    const page: Page = await graphql<Page>(token, PENDING_QUERY, { owner, repo: name, number: prNumber, after }, repo);
    const pr = page.repository.pullRequest;
    review ??= pr.reviews.nodes.find((r) => r.viewerDidAuthor)?.id;
    if (!review) return null;
    for (const t of pr.reviewThreads.nodes) {
      // Someone else's pending comments never show; a PENDING one here is the person's.
      const pending = t.comments.nodes.filter((c) => c.state === 'PENDING');
      if (!pending.length) continue;
      threads.push({
        id: t.id,
        path: t.path,
        subject: t.subjectType === 'FILE' ? 'file' : 'line',
        side: t.diffSide,
        line: t.line,
        startLine: t.startLine,
        originalLine: t.originalLine,
        isNew: pending.length === t.comments.nodes.length,
        comments: pending.map((c) => ({ nodeId: c.id, id: c.databaseId, body: c.body, createdAt: c.createdAt })),
      });
    }
    after = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (after);
  return { id: review, threads };
}

// A pending review on the commit the person is looking at.
export async function startReview(token: string, repo: string, prId: string, commitId: string): Promise<string> {
  const data = await graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(token, `mutation($pr: ID!, $commit: GitObjectID!) { addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) { pullRequestReview { id } } }`, { pr: prId, commit: commitId }, repo);
  return data.addPullRequestReview.pullRequestReview.id;
}

export async function addReviewThread(token: string, repo: string, reviewId: string, spot: DiffSpot, body: string): Promise<void> {
  const where = spot.subject === 'file'
    ? { subjectType: 'FILE' }
    : { subjectType: 'LINE', line: spot.line, side: spot.side, ...(spot.startLine !== undefined && spot.startLine !== spot.line ? { startLine: spot.startLine, startSide: spot.side } : {}) };
  await graphql(token, `mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }`, { input: { pullRequestReviewId: reviewId, path: spot.path, body, ...where } }, repo);
}

export async function addReviewReply(token: string, repo: string, reviewId: string, threadId: string, body: string): Promise<void> {
  await graphql(token, `mutation($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`, { review: reviewId, thread: threadId, body }, repo);
}

export async function editReviewComment(token: string, repo: string, nodeId: string, body: string): Promise<void> {
  await graphql(token, `mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } } }`, { id: nodeId, body }, repo);
}

export async function deleteReviewComment(token: string, repo: string, nodeId: string): Promise<void> {
  await graphql(token, `mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }`, { id: nodeId }, repo);
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

// Sends the pending review, or, with none, a review with only its summary
// (an approval without comments).
export async function submitReview(token: string, repo: string, review: { prId: string; commitId: string; pendingId?: string; event: ReviewEvent; body: string }): Promise<{ url: string }> {
  if (review.pendingId) {
    const data = await graphql<{ submitPullRequestReview: { pullRequestReview: { url: string } } }>(token, `mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { pullRequestReview { url } } }`, { id: review.pendingId, event: review.event, body: review.body || null }, repo);
    return { url: data.submitPullRequestReview.pullRequestReview.url };
  }
  const data = await graphql<{ addPullRequestReview: { pullRequestReview: { url: string } } }>(token, `mutation($pr: ID!, $commit: GitObjectID!, $event: PullRequestReviewEvent!, $body: String) { addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: $event, body: $body }) { pullRequestReview { url } } }`, { pr: review.prId, commit: review.commitId, event: review.event, body: review.body || null }, repo);
  return { url: data.addPullRequestReview.pullRequestReview.url };
}

export async function discardReview(token: string, repo: string, reviewId: string): Promise<void> {
  await graphql(token, `mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }`, { id: reviewId }, repo);
}
