import { join } from 'node:path';
import { runAgentTask } from '@platform/agents/agent-task.js';
import { explorationTask } from './prompts.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { log } from '@platform/logger.js';
import { mergeInventory, saveInventory, type ExplorationMemory, type Inventory } from './memory.js';
import { codeHistory, lastCommitTouching, parseDiscoveredFunctions } from './plan.js';
import type { AppDefinition } from '../product-app/index.js';
import { host } from '@platform/host/host.js';

export function explorationOutDir(): string {
  // Outside every checkout: the agent writes here, the supervisor reads it.
  return join(activeRepo().worktreeBasePath, 'exploration-out');
}

// Brings the inventory up to date with the app's code before planning a run
// (docs/DESIGN.md §11.4) — but only when something under the app's path
// changed since the last refresh: an unchanged app has the same functions,
// and this is an agent run. Writes inventory.yml in the memory dir and
// returns the merged inventory.
export async function refreshInventory(opts: {
  appName: string;
  app: AppDefinition;
  // Where the app's code is read from (its base-branch checkout).
  codeDir: string;
  memory: ExplorationMemory;
  today: string;
}): Promise<{ inventory: Inventory; added: string[]; retired: string[]; refreshed: boolean }> {
  const { appName, app, codeDir, memory, today } = opts;
  const history = await codeHistory(codeDir);
  const sha = await lastCommitTouching(history.dir, app.path, history.rev);
  if (memory.inventory.actualizado?.sha === sha && memory.inventory.funciones.length > 0) {
    log.info(`exploración ${appName}: inventario al día con ${sha.slice(0, 7)}, no se refresca`);
    return { inventory: memory.inventory, added: [], retired: [], refreshed: false };
  }

  // A directory of its own: the agent writes only there (sealed, #257).
  const outDir = join(explorationOutDir(), `inventory-${appName}`);
  await host().fs.rm(outDir, { recursive: true, force: true });
  await host().fs.mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, 'functions.json');
  await runAgentTask(explorationTask({
    type: 'explore-inventory',
    appName,
    appPath: app.path,
    checkoutDir: codeDir,
    outputPath,
    roles: app.users.map((u) => u.role),
    known: memory.inventory.funciones.filter((f) => !f.retirada).map((f) => ({ id: f.id, nombre: f.nombre, rutas: f.rutas })),
  }));

  let raw: string;
  try {
    raw = await host().fs.readFile(outputPath, 'utf8');
  } catch {
    throw new Error(`explore-inventory no escribió ${outputPath}`);
  }
  const { functions, dropped } = parseDiscoveredFunctions(raw);
  for (const d of dropped) log.info(`exploración ${appName}: función descartada del inventario (${d})`);
  if (functions.length === 0) throw new Error('explore-inventory no encontró ninguna función válida');

  const merged = mergeInventory(memory.inventory, functions, today, sha);
  await saveInventory(memory.dir, merged.inventory);
  log.info(`exploración ${appName}: inventario con ${functions.length} funciones (${merged.added.length} nuevas, ${merged.retired.length} retiradas)`);
  return { ...merged, refreshed: true };
}
