import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { config } from './config.js';

// Installation tokens last ~1h; a single tick should finish well within
// that, so caching per-process (not persisted across ticks) is enough —
// no need to handle mid-tick refresh.
let cached: { token: string; expiresAt: number } | null = null;

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
