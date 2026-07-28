import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { config } from './config.js';

// Installation tokens last ~1h; a single tick should finish well within
// that, so caching per-process (not persisted across ticks) is enough —
// no need to handle mid-tick refresh.
let cached: { token: string; expiresAt: number } | null = null;

// A *different* credential from the installation token below: this is the
// short-lived JWT signed with the App's private key, which authenticates as
// the App itself rather than as its installation on a repo. Only this
// identity can read `GET /app` (the App's own metadata, including its slug) —
// an installation token gets a 403 there. Not cached: it's only used by
// scripts/smoke-test.ts, not on the tick hot path.
export async function getAppJwt(): Promise<string> {
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: readFileSync(config.githubAppPrivateKeyPath, 'utf8'),
  });
  const { token } = await auth({ type: 'app' });
  return token;
}

export async function getInstallationToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.token;
  }

  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: readFileSync(config.githubAppPrivateKeyPath, 'utf8'),
    installationId: config.githubAppInstallationId,
  });
  const { token, expiresAt } = await auth({ type: 'installation' });
  cached = { token, expiresAt: new Date(expiresAt).getTime() };
  return token;
}
