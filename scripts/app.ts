// Brings an app of a product repo up (or down) from its ronin.app.json, on
// a detached worktree of the repo's base branch — the same way exploration
// runs it. See docs/DESIGN.md §11.2.
//
//   pnpm app up    --repo redmotos/shoppingcart --app backoffice [--ref origin/odoo-main]
//   pnpm app smoke --repo redmotos/shoppingcart --app backoffice [--ref …] [--keep]
//   pnpm app down  --repo redmotos/shoppingcart --app backoffice
//
// `up` leaves the app running and prints where; `down` stops it. `smoke`
// logs every manifest user in and takes a screenshot of each role's home at
// desktop and mobile size (into logs/app-smoke/), reusing an app `up` left
// running or bringing one up and down for the occasion (--keep leaves it up).
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadRepos } from '../src/core/repos.js';
import { withActiveRepo } from '../src/core/repo-context.js';
import { appDown, appUp, appWorktreeDirFor, attachApp, ensureAppWorktree, type AppSession } from '../src/app/index.js';
import { loginAllUsers, smokeScreenshots } from '../src/app/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    app: { type: 'string' },
    ref: { type: 'string' },
    keep: { type: 'boolean' },
  },
});

const command = positionals[0];
if (!['up', 'down', 'smoke'].includes(command) || !values.repo || !values.app) {
  console.error('Uso: pnpm app <up|smoke|down> --repo <owner/name> --app <nombre> [--ref <ref>] [--keep]');
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

  const running = command === 'smoke' && !values.ref ? await attachApp(dir) : null;
  const session = running ?? (await appUp(await ensureAppWorktree(appName, values.ref), appName));
  if (command === 'up') {
    printSession(session);
    return;
  }

  try {
    const states = await loginAllUsers(session);
    const outDir = join(process.cwd(), 'logs', 'app-smoke', `${entry.productRepo.replace('/', '-')}-${appName}`);
    for (const shot of await smokeScreenshots(session, states, outDir)) {
      const errors = shot.consoleErrors.length > 0 ? ` — ${shot.consoleErrors.length} error(es) de consola: ${shot.consoleErrors.slice(0, 3).join(' | ')}` : '';
      console.log(`${shot.role} ${shot.viewport}: ${shot.url} → ${shot.path}${errors}`);
    }
  } finally {
    if (!running && !values.keep) await appDown(session.dir);
  }
});
