import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getInstallationToken } from '../src/github-app-auth.js';
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

  console.log('\nSmoke test completo: el GitHub App autentica y tiene acceso de lectura al repo.');
}

main().catch((error) => {
  console.error('Smoke test falló:', error);
  process.exitCode = 1;
});
