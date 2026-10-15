import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentTask } from '../core/agent-task.js';
import { activeRepo } from '../core/repo-context.js';
import { log } from '../core/logger.js';
import { mergeInventory, saveInventory, type ExplorationMemory, type Inventory } from './memory.js';
import { lastCommitTouching, parseDiscoveredFunctions } from './plan.js';
import type { AppDefinition } from '../app/index.js';

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
  const sha = await lastCommitTouching(codeDir, app.path);
  if (memory.inventory.actualizado?.sha === sha && memory.inventory.funciones.length > 0) {
    log.info(`exploración ${appName}: inventario al día con ${sha.slice(0, 7)}, no se refresca`);
    return { inventory: memory.inventory, added: [], retired: [], refreshed: false };
  }

  await mkdir(explorationOutDir(), { recursive: true });
  const outputPath = join(explorationOutDir(), `${appName}-functions.json`);
  await rm(outputPath, { force: true });
  await runAgentTask({
    type: 'explore-inventory',
    appName,
    appPath: app.path,
    checkoutDir: codeDir,
    outputPath,
    roles: app.users.map((u) => u.role),
    known: memory.inventory.funciones.filter((f) => !f.retirada).map((f) => ({ id: f.id, nombre: f.nombre, rutas: f.rutas })),
  });

  let raw: string;
  try {
    raw = await readFile(outputPath, 'utf8');
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
