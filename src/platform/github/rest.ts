import { timedGithub } from '../timing.js';

// GitHub's REST API, as ronin calls it everywhere: its headers, a timeout,
// and the time it takes counted as Server-Timing's github (#235, stage 1).
// What an answer means (a 401, a 404) is each caller's to say.

export const GITHUB_API = 'https://api.github.com';

const TIMEOUT_MS = 15_000;

export interface GithubRequest {
  // A token, sent as Bearer; or the whole Authorization header (Basic).
  token?: string;
  authorization?: string;
  method?: string;
  body?: unknown;
}

// `path`: from the API's root, like /repos/<owner>/<name>.
export function githubFetch(path: string, req: GithubRequest = {}): Promise<Response> {
  const authorization = req.authorization ?? (req.token ? `Bearer ${req.token}` : undefined);
  return timedGithub(() => fetch(`${GITHUB_API}${path}`, {
    method: req.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ronin-dashboard',
      ...(authorization ? { Authorization: authorization } : {}),
      ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
}

// "owner/name" in its two parts.
export function parseRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, name };
}
