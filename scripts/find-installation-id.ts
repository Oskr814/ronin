import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { config } from '../src/config.js';

async function main() {
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: readFileSync(config.githubAppPrivateKeyPath, 'utf8'),
  });

  const appAuth = await auth({ type: 'app' });
  const res = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${appAuth.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    console.error(`GitHub API respondió ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
    return;
  }

  const installations = (await res.json()) as Array<{ id: number; account: { login: string }; target_type: string }>;
  console.log(`Instalaciones encontradas: ${installations.length}`);
  for (const inst of installations) {
    console.log(`  id=${inst.id}  account=${inst.account.login}  target_type=${inst.target_type}`);
  }
}

main().catch((error) => {
  console.error('Falló:', error);
  process.exitCode = 1;
});
