// What the dashboard does on GitHub, done as whoever is logged in (#93):
// with the token their session carries (auth.ts), never ronin's. A comment
// written this way reaches ronin like one written on GitHub — its webhook,
// then the same handler — so nothing downstream needs to know it came from
// the dashboard.

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
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ronin-dashboard',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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

// A new issue, as the person; `assignees` set at creation (ronin, to take it).
export async function createIssue(token: string, repo: string, issue: { title: string; body: string; assignees?: string[] }): Promise<{ number: number; url: string }> {
  const created = await call<{ number: number; html_url: string }>(token, 'POST', `/repos/${repo}/issues`, issue);
  return { number: created.number, url: created.html_url };
}

// GraphQL, as the person: what REST doesn't have (resolving a thread,
// marking a file as viewed). GitHub answers 200 with `errors` when it says no.
async function graphql<T>(token: string, query: string, variables: Record<string, unknown>, repo: string): Promise<T> {
  const response = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ronin-dashboard' },
    body: JSON.stringify({ query, variables }),
  });
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
