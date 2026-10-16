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
  const said = await response.json().then((b: { message?: string }) => b?.message).catch(() => undefined);
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
