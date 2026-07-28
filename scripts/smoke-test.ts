import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getInstallationToken, getAppJwt } from '../src/github-app-auth.js';
import { listTrackingIssues } from '../src/github.js';
import { config } from '../src/config.js';

const execFileAsync = promisify(execFile);

async function main() {
  console.log('1. Solicitando installation token...');
  const token = await getInstallationToken();
  console.log(`   OK — token adquirido (longitud ${token.length}, no se imprime el valor)`);

  console.log(`2. Verificando lectura real de ${config.productRepo} con ese token...`);
  const { stdout } = await execFileAsync('gh', ['repo', 'view', config.productRepo, '--json', 'name,visibility'], {
    env: { ...process.env, GH_TOKEN: token },
  });
  console.log(`   OK — ${stdout.trim()}`);

  console.log('3. Listando issues valeria:ready (se esperan 0, todavía no hay specs procesados)...');
  const ready = await listTrackingIssues('ready');
  console.log(`   OK — ${ready.length} issue(s) encontrados`);

  // Un VALERIA_GITHUB_APP_SLUG mal escrito no falla ruidosamente en ningún
  // lado: hasBotReaction simplemente nunca matchea, así que ninguna mención se
  // considera procesada y el supervisor re-postea la misma review en cada tick,
  // para siempre. Se verifica acá contra la fuente de verdad.
  //
  // No usa `gh api`: GET /app exige autenticarse como el App (JWT, header
  // "Authorization: Bearer <jwt>"), y gh siempre arma el header él mismo a
  // partir de GH_TOKEN con el esquema "token", que ese endpoint rechaza.
  console.log('4. Verificando que VALERIA_GITHUB_APP_SLUG coincida con el slug real del App...');
  const jwt = await getAppJwt();
  const response = await fetch('https://api.github.com/app', {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`GET /app falló (${response.status} ${response.statusText}): ${await response.text()}`);
  }
  const { slug } = (await response.json()) as { slug: string };
  if (slug !== config.githubAppSlug) {
    throw new Error(
      `VALERIA_GITHUB_APP_SLUG="${config.githubAppSlug}" no coincide con el slug real del App ("${slug}"). ` +
        'Con este valor mal seteado, la detección de @menciones re-postea la misma review en cada tick sin error visible ' +
        '— corregilo en el .env antes de seguir.',
    );
  }
  console.log(`   OK — slug "${slug}", bot user "${slug}[bot]"`);

  console.log('\nSmoke test completo: el GitHub App autentica y tiene acceso de lectura al repo.');
}

main().catch((error) => {
  console.error('Smoke test falló:', error);
  process.exitCode = 1;
});
