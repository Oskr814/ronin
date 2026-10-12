// Brings an app of a product repo up (or down) from its ronin.app.json, on
// a detached worktree of the repo's base branch — the same way exploration
// runs it. See docs/DESIGN.md §11.2.
//
//   pnpm app up   --repo redmotos/shoppingcart --app backoffice [--ref origin/odoo-main]
//   pnpm app down --repo redmotos/shoppingcart --app backoffice
//
// `up` leaves the app running and prints where; `down` stops it.
import { parseArgs } from 'node:util';
import { loadRepos } from '../src/repos.js';
import { withActiveRepo } from '../src/repo-context.js';
import { appDown, appUp, appWorktreeDirFor, ensureAppWorktree, type AppSession } from '../src/app-runtime.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    app: { type: 'string' },
    ref: { type: 'string' },
  },
});

const command = positionals[0];
if (!['up', 'down'].includes(command) || !values.repo || !values.app) {
  console.error('Uso: pnpm app <up|down> --repo <owner/name> --app <nombre> [--ref <ref>]');
  process.exit(1);
}

const entry = (await loadRepos()).find((r) => r.productRepo === values.repo);
if (!entry) {
  console.error(`${values.repo} no está en repos.json`);
  process.exit(1);
}

function printSession(session: AppSession): void {
  console.log(`${session.appName}: arriba en ${session.baseUrl}`);
  console.log(`checkout: ${session.dir}`);
  console.log(`logs: ${session.stateDir}`);
  for (const [service, ports] of Object.entries(session.ctx.ports)) {
    for (const [target, host] of Object.entries(ports)) console.log(`  ${service}:${target} → 127.0.0.1:${host}`);
  }
}

const appName = values.app;
await withActiveRepo(entry, async () => {
  const dir = appWorktreeDirFor(appName);
  if (command === 'down') {
    await appDown(dir);
    console.log(`${appName}: abajo`);
    return;
  }

  printSession(await appUp(await ensureAppWorktree(appName, values.ref), appName));
});
