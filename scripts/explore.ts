// Exploration from the command line, without touching GitHub — to try the
// mechanism by hand before it runs on its own (docs/DESIGN.md §11.10,
// "iterar la calidad a mano"). The memory lives in a local directory
// (default logs/exploration/<repo>-<app>/), seeded from the base branch's
// docs/exploration/<app>/ the first time.
//
//   pnpm explore plan --repo redmotos/shoppingcart --app backoffice [--seed 123] [--max 3] [--memory <dir>] [--ref <ref>]
//   pnpm explore run  --repo redmotos/shoppingcart --app backoffice [--seed 123] [--max 3] [--memory <dir>] [--ref <ref>] [--no-mockups]
//
// `plan` refreshes the inventory (an agent run, only when the app's code
// changed) and prints the functions, charters and roles one run would test.
// `run` does the whole run — brings the app up, explores, evaluates — and
// writes the findings and the run file into the memory directory.
import { parseArgs } from 'node:util';
import { cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRepos } from '../src/repos.js';
import { withActiveRepo } from '../src/repo-context.js';
import { ensureAppWorktree } from '../src/app-runtime.js';
import { loadAppDefinition } from '../src/app-manifest.js';
import { ensureMemoryDir, loadMemory, memoryDirFor } from '../src/exploration-memory.js';
import { refreshInventory } from '../src/exploration-inventory.js';
import { changedFunctions, newSeed, planRun, riskByFunction } from '../src/exploration-plan.js';
import { runExploration } from '../src/exploration-run.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    app: { type: 'string' },
    ref: { type: 'string' },
    seed: { type: 'string' },
    max: { type: 'string' },
    memory: { type: 'string' },
    'no-mockups': { type: 'boolean' },
  },
});

const command = positionals[0];
if ((command !== 'plan' && command !== 'run') || !values.repo || !values.app) {
  console.error('Uso: pnpm explore <plan|run> --repo <owner/name> --app <nombre> [--seed <n>] [--max <n>] [--memory <dir>] [--ref <ref>] [--no-mockups]');
  process.exit(1);
}

const entry = (await loadRepos()).find((r) => r.productRepo === values.repo);
if (!entry) {
  console.error(`${values.repo} no está en repos.json`);
  process.exit(1);
}

const appName = values.app;
const today = new Date().toISOString().slice(0, 10);
await withActiveRepo(entry, async () => {
  const codeDir = await ensureAppWorktree(appName, values.ref);
  const app = await loadAppDefinition(codeDir, appName);
  const memoryDir = values.memory ?? join(process.cwd(), 'logs', 'exploration', `${entry.productRepo.replace('/', '-')}-${appName}`);
  if (!existsSync(memoryDir) && existsSync(memoryDirFor(codeDir, appName))) await cp(memoryDirFor(codeDir, appName), memoryDir, { recursive: true });
  await ensureMemoryDir(memoryDir);

  if (command === 'run') {
    const summary = await runExploration({
      appName,
      codeDir,
      memoryDir,
      today,
      ...(values.seed ? { seed: Number(values.seed) } : {}),
      ...(values.max ? { maxFunctions: Number(values.max) } : {}),
      publishMockups: !values['no-mockups'],
    });
    console.log(`corrida ${summary.runId}: ${summary.findings.length} propuesta(s), ${summary.discarded.length} descartada(s)`);
    for (const o of summary.outcomes) console.log(`- ${o.planned.functionId} (${o.planned.charter}, ${o.planned.role}): ${o.status}${o.error ? ` — ${o.error}` : ''}`);
    for (const f of summary.findings) console.log(`  ${f.id} [${f.tipo}/${f.gravedad}] ${f.titulo}${f.mockup ? ` — ${f.mockup}` : ''}`);
    console.log(`detalle: ${summary.runFile}`);
    return;
  }

  const memory = await loadMemory(memoryDir);
  const { inventory, added, retired } = await refreshInventory({ appName, app, codeDir, memory, today });
  const plan = planRun({
    inventory,
    changed: await changedFunctions(codeDir, inventory),
    risk: await riskByFunction(codeDir, inventory),
    roles: app.users.map((u) => u.role),
    maxFunctions: Number(values.max ?? 3),
    seed: values.seed ? Number(values.seed) : newSeed(),
  });

  console.log(`memoria: ${memoryDir}`);
  console.log(`inventario: ${inventory.funciones.filter((f) => !f.retirada).length} funciones${added.length ? `, nuevas: ${added.join(', ')}` : ''}${retired.length ? `, retiradas: ${retired.join(', ')}` : ''}`);
  console.log(`semilla: ${plan.seed}`);
  for (const p of plan.functions) console.log(`- ${p.functionId} (${p.reason}) — charter ${p.charter}, rol ${p.role}`);
});
