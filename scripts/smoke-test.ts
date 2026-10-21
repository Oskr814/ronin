import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '@platform/config/config.js';
import { loadRepos } from '@platform/config/repos.js';
import { withActiveRepo } from '@platform/agents/repo-context.js';
import { listTrackingIssues } from '@platform/github/github.js';

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

      // Soft check: el commit status `ronin/review` (ver setReviewStatus) es
      // puramente informativo, así que un PAT sin el permiso `Commit
      // statuses: read and write` no bloquea el setup — solo se pierde el
      // check en la caja del PR mientras ronin revisa. Se escribe sobre el
      // tip del branch default con un context propio y estado `success`;
      // queda ahí, inofensivo, y se mueve con el branch.
      console.log(`4. Verificando permiso de commit statuses en ${repo.productRepo} (opcional)...`);
      try {
        const { stdout: shaStdout } = await execFileAsync(
          'gh',
          ['api', `repos/${repo.productRepo}/commits/HEAD`, '--jq', '.sha'],
          { env: { ...process.env, GH_TOKEN: config.githubToken } },
        );
        await execFileAsync(
          'gh',
          [
            'api', '--method', 'POST',
            `repos/${repo.productRepo}/statuses/${shaStdout.trim()}`,
            '-f', 'state=success',
            '-f', 'context=ronin/smoke-test',
            '-f', 'description=smoke test de commit status — ignorar',
          ],
          { env: { ...process.env, GH_TOKEN: config.githubToken } },
        );
        console.log('   OK — el PAT puede escribir commit statuses');
      } catch {
        console.warn(
          '   AVISO — el PAT no puede escribir commit statuses. ronin va a funcionar igual, ' +
            'pero no vas a ver el check "ronin/review" en el PR mientras corre una review. ' +
            'Agregá el permiso "Commit statuses: read and write" al token si lo querés.',
        );
      }
    });
  }

  console.log('\nSmoke test completo: el PAT autentica y tiene acceso de lectura a todos los repos de repos.json.');
}

main().catch((error) => {
  console.error('Smoke test falló:', error);
  process.exitCode = 1;
});
