import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config/config.js';
import { githubFetch, parseRepo } from './rest.js';

// The token an agent reads GitHub with (#257): minted per run by ronin's
// GitHub App, read-only and limited to the run's repo, gone in an hour. The
// write token stays with the supervisor, which writes through the actions
// (platform/actions). Without the App configured there is none, and the
// agent keeps reading with the write token, as before.

// What the agent reads today: the PR, its diff and comments, the issue,
// checks, CI logs and statuses.
export const READ_PERMISSIONS = {
  contents: 'read',
  pull_requests: 'read',
  issues: 'read',
  metadata: 'read',
  checks: 'read',
  actions: 'read',
  statuses: 'read',
} as const;

export class ReadTokenError extends Error {}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

// The App's own JWT (RS256, ten minutes at most; a minute back for clock
// drift), good only for asking for installation tokens.
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

export function readTokenConfigured(): boolean {
  return Boolean(config.githubApp.appId && config.githubApp.privateKeyPath);
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new ReadTokenError(`${what}: GitHub respondió ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// Null without the App. Throws when the App is configured but the token
// can't be had: the run waits for the next try rather than read with the
// write token.
export async function mintReadToken(repo: string): Promise<string | null> {
  if (!readTokenConfigured()) return null;
  const { owner, name } = parseRepo(repo);
  const jwt = appJwt(config.githubApp.appId, await readFile(config.githubApp.privateKeyPath, 'utf8'));
  const installation = await json<{ id: number }>(
    await githubFetch(`/repos/${owner}/${name}/installation`, { token: jwt }),
    `la GitHub App no está instalada en ${repo}`,
  );
  const minted = await json<{ token: string }>(
    await githubFetch(`/app/installations/${installation.id}/access_tokens`, {
      token: jwt,
      method: 'POST',
      body: { repositories: [name], permissions: READ_PERMISSIONS },
    }),
    `no se pudo crear el token de lectura de ${repo}`,
  );
  return minted.token;
}
