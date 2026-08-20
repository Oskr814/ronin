import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { loadRepos } from '../src/repos.js';
import { withActiveRepo } from '../src/repo-context.js';
import { listTrackingIssues } from '../src/github.js';

const execFileAsync = promisify(execFile);

async function main() {
  console.log('1. Verificando que RONIN_GITHUB_TOKEN autentica como RONIN_GITHUB_LOGIN...');
  const { stdout: userStdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
    env: { ...process.env, GH_TOKEN: config.githubToken },
  });
  const login = userStdout.trim();
  if (login !== config.githubLogin) {
    throw new Error(
      `El token autentica como "${login}", pero RONIN_GITHUB_LOGIN="${config.githubLogin}". ` +
        'Con este valor mal seteado, la detección de @menciones nunca matchea al bot — corregilo en el .env antes de seguir.',
    );
  }
  console.log(`   OK — autentica como "${login}"`);

  console.log('2. Cargando repos.json...');
  const repos = await loadRepos();
  console.log(`   OK — ${repos.length} repo(s) configurados`);

  for (const repo of repos) {
    await withActiveRepo(repo, async () => {
      console.log(`3. Verificando lectura de ${repo.productRepo}...`);
      const { stdout } = await execFileAsync('gh', ['repo', 'view', repo.productRepo, '--json', 'name,visibility'], {
        env: { ...process.env, GH_TOKEN: config.githubToken },
      });
      console.log(`   OK — ${stdout.trim()}`);

      const ready = await listTrackingIssues('ready');
      console.log(`   OK — ${ready.length} issue(s) ronin:ready encontrados en ${repo.productRepo}`);
    });
  }

  console.log('\nSmoke test completo: el PAT autentica y tiene acceso de lectura a todos los repos de repos.json.');
}

main().catch((error) => {
  console.error('Smoke test falló:', error);
  process.exitCode = 1;
});
