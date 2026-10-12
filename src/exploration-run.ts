import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentTask, type ExistingFindingSummary } from './agent-task.js';
import { appDown, appUp } from './app-runtime.js';
import { loginAllUsers } from './app-browser.js';
import { loadAppDefinition, type AppDefinition } from './app-manifest.js';
import { config } from './config.js';
import { log } from './logger.js';
import { publishArtifact } from './artifact-publisher.js';
import {
  ensureMemoryDir,
  findDuplicate,
  loadMemory,
  nextFindingId,
  recordCoverage,
  saveInventory,
  VIEWPORTS,
  writeFinding,
  type ExplorationMemory,
  type Finding,
  type Inventory,
} from './exploration-memory.js';
import { refreshInventory, explorationOutDir } from './exploration-inventory.js';
import { changedFunctions, newSeed, planRun, riskByFunction, type ExplorationPlan, type PlannedFunction } from './exploration-plan.js';
import { capCandidates, parseFunctionResult, parseVerdicts, renderFindingBody, type Candidate, type TriedTask } from './exploration-output.js';

const execFileAsync = promisify(execFile);

// One exploration run end to end — docs/DESIGN.md §11.3–11.6: refresh the
// inventory, plan, bring the app up, explore each planned function in its
// own headless session (with a desktop and a mobile browser), then dedupe,
// evaluate and cap what came back, publish mockups, and write the findings,
// the coverage and the run file into the memory directory. Nothing here
// touches GitHub: the weekly PR flow (exploration-pr.ts) commits the memory
// directory and opens the PR.

export interface RunOptions {
  appName: string;
  // Checkout the app runs from and whose code the agents read.
  codeDir: string;
  // The memory directory to read and update (docs/exploration/<app> of the
  // weekly branch, or a local one for a dry run).
  memoryDir: string;
  today: string;
  seed?: number;
  maxFunctions?: number;
  publishMockups?: boolean;
  // Checked before each function: false stops the run there (a more urgent
  // task arrived, or the night window closed). What was explored is kept.
  shouldContinue?: () => boolean | Promise<boolean>;
}

export interface FunctionOutcome {
  planned: PlannedFunction;
  status: 'explorada' | 'fallo' | 'omitida';
  tareas: TriedTask[];
  error?: string;
}

export interface RunSummary {
  runId: string;
  seed: number;
  plan: ExplorationPlan;
  outcomes: FunctionOutcome[];
  findings: Finding[];
  discarded: Array<{ titulo: string; funcion: string; motivo: string }>;
  runFile: string;
  inventory: { added: string[]; retired: string[]; refreshed: boolean };
}

interface PendingCandidate extends Candidate {
  functionId: string;
  functionName: string;
  planned: PlannedFunction;
}

function mcpServer(app: AppDefinition, viewport: 'desktop' | 'mobile', storageState: string, outputDir: string, origins: string[]) {
  const vp = app.viewports[viewport];
  return {
    command: join(process.cwd(), 'node_modules', '.bin', 'playwright-mcp'),
    args: [
      // Playwright's own Chromium (installed with `npx playwright install
      // chromium`); the server's default is the Google Chrome channel, which
      // a runner host usually doesn't have.
      '--browser', 'chromium',
      '--headless',
      '--isolated',
      '--storage-state', storageState,
      ...(vp.isMobile ? ['--device', 'iPhone 13', '--viewport-size', `${vp.width}x${vp.height}`] : ['--viewport-size', `${vp.width}x${vp.height}`]),
      '--output-dir', outputDir,
      // The explorer's browsers only reach the app and its own services.
      '--allowed-origins', origins.join(';'),
    ],
  };
}

function originsOf(baseUrl: string, ports: Record<string, Record<string, number>>, named: Record<string, number>): string[] {
  const origins = new Set([new URL(baseUrl).origin]);
  for (const byTarget of Object.values(ports)) for (const port of Object.values(byTarget)) origins.add(`http://127.0.0.1:${port}`);
  for (const port of Object.values(named)) origins.add(`http://127.0.0.1:${port}`);
  return [...origins].flatMap((o) => [o, o.replace('127.0.0.1', 'localhost')]);
}

// The explorer edits code to take its "after" screenshots and is told to
// revert; this makes sure of it, so the next function starts from the base.
async function ensureCleanCheckout(dir: string, appPath: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
  if (!stdout.trim()) return;
  log.info(`exploración: el explorador dejó cambios en el checkout, revirtiendo:\n${stdout.trim()}`);
  await execFileAsync('git', ['checkout', '--', '.'], { cwd: dir });
  await execFileAsync('git', ['clean', '-fd', '--', appPath], { cwd: dir });
}

function summarizeExisting(memory: ExplorationMemory): ExistingFindingSummary[] {
  return memory.findings.map((f) => ({ id: f.id, funcion: f.funcion, titulo: f.titulo, estado: f.estado, huella: f.huella, ...(f.motivo ? { motivo: f.motivo } : {}) }));
}

function runFileName(dir: string, runId: string): string {
  return join(dir, 'runs', `${runId}.md`);
}

export async function runExploration(opts: RunOptions): Promise<RunSummary> {
  const { appName, codeDir, memoryDir, today } = opts;
  const app = await loadAppDefinition(codeDir, appName);
  await ensureMemoryDir(memoryDir);
  let memory = await loadMemory(memoryDir);

  const refreshed = await refreshInventory({ appName, app, codeDir, memory, today });
  let inventory: Inventory = refreshed.inventory;
  memory = { ...memory, inventory };

  const seed = opts.seed ?? newSeed();
  const plan = planRun({
    inventory,
    changed: await changedFunctions(codeDir, inventory),
    risk: await riskByFunction(codeDir, inventory),
    roles: app.users.map((u) => u.role),
    maxFunctions: opts.maxFunctions ?? config.exploreFunctionsPerRun,
    seed,
  });
  const runId = `${today}-${seed}`;
  const outRoot = join(explorationOutDir(), runId);
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });
  log.info(`exploración ${appName}: corrida ${runId}, ${plan.functions.map((p) => `${p.functionId} (${p.charter})`).join(', ')}`);

  const outcomes: FunctionOutcome[] = [];
  const pending: PendingCandidate[] = [];
  const discarded: RunSummary['discarded'] = [];
  const existing = summarizeExisting(memory);

  const session = await appUp(codeDir, appName);
  try {
    const authStates = await loginAllUsers(session);
    const origins = originsOf(session.baseUrl, session.ctx.ports, session.ctx.port);
    for (const planned of plan.functions) {
      if (opts.shouldContinue && !(await opts.shouldContinue())) {
        outcomes.push({ planned, status: 'omitida', tareas: [] });
        continue;
      }
      const fn = inventory.funciones.find((f) => f.id === planned.functionId)!;
      const fnOut = join(outRoot, fn.id);
      await mkdir(join(fnOut, 'mockups'), { recursive: true });
      await mkdir(join(fnOut, 'patches'), { recursive: true });
      const mcpConfigPath = join(fnOut, 'mcp.json');
      await writeFile(mcpConfigPath, JSON.stringify({
        mcpServers: {
          desktop: mcpServer(app, 'desktop', authStates[planned.role], join(fnOut, 'desktop'), origins),
          mobile: mcpServer(app, 'mobile', authStates[planned.role], join(fnOut, 'mobile'), origins),
        },
      }, null, 2));
      const outputPath = join(fnOut, 'result.json');
      try {
        await runAgentTask({
          type: 'explore-function',
          appName,
          appPath: app.path,
          checkoutDir: codeDir,
          outDir: fnOut,
          outputPath,
          mcpConfigPath,
          baseUrl: session.baseUrl,
          homePath: app.homePath ?? '/',
          fn: { id: fn.id, nombre: fn.nombre, rutas: fn.rutas, ...(fn.notas ? { notas: fn.notas } : {}) },
          charter: planned.charter,
          role: planned.role,
          roleNotes: app.users.find((u) => u.role === planned.role)?.notes,
          seed,
          knowledge: memory.knowledge,
          existing,
          maxIdeas: config.exploreIdeasPerRun,
        });
        const { result, dropped } = parseFunctionResult(await readFile(outputPath, 'utf8'), fn.id, fnOut);
        for (const d of dropped) discarded.push({ titulo: d, funcion: fn.id, motivo: 'no cumple el contrato' });
        pending.push(...result.candidatos.map((c) => ({ ...c, functionId: fn.id, functionName: fn.nombre, planned })));
        outcomes.push({ planned, status: 'explorada', tareas: result.tareas });
      } catch (error) {
        log.error(`exploración ${appName}: ${fn.id} falló`, error);
        outcomes.push({ planned, status: 'fallo', tareas: [], error: (error as Error).message.slice(0, 300) });
      } finally {
        await ensureCleanCheckout(codeDir, app.path).catch((error) => log.error('exploración: no se pudo limpiar el checkout', error));
      }
    }
  } finally {
    await appDown(codeDir);
  }

  // Repeats of what the memory already has (rejected included), and of each
  // other within this run, never reach the evaluator.
  const fresh: PendingCandidate[] = [];
  for (const c of pending) {
    const repeat = findDuplicate({ funcion: c.functionId, huella: c.huella }, [
      ...memory.findings,
      ...fresh.map((f, i) => ({ id: `candidato ${i}`, funcion: f.functionId, huella: f.huella })),
    ]);
    if (repeat) discarded.push({ titulo: c.titulo, funcion: c.functionId, motivo: `repite ${repeat}` });
    else fresh.push(c);
  }

  let kept: PendingCandidate[] = [];
  if (fresh.length > 0) {
    const candidatesPath = join(outRoot, 'candidates.json');
    const verdictsPath = join(outRoot, 'verdicts.json');
    await writeFile(candidatesPath, JSON.stringify(fresh.map(({ planned, ...c }, index) => ({ index, funcion: c.functionId, nombreFuncion: c.functionName, charter: planned.charter, rol: planned.role, ...c })), null, 2));
    try {
      await runAgentTask({ type: 'explore-evaluate', appName, checkoutDir: codeDir, candidatesPath, outputPath: verdictsPath, knowledge: memory.knowledge, existing });
      const verdicts = parseVerdicts(await readFile(verdictsPath, 'utf8'), fresh.length);
      for (const v of verdicts) {
        const c = fresh[v.index];
        if (v.veredicto === 'mantener') kept.push(v.gravedad && c.tipo === 'hallazgo' ? { ...c, gravedad: v.gravedad } : c);
        else discarded.push({ titulo: c.titulo, funcion: c.functionId, motivo: `evaluador: ${v.motivo}` });
      }
    } catch (error) {
      // Without the evaluator nothing is published: it is the gate.
      log.error(`exploración ${appName}: el evaluador falló, no se publica nada de esta corrida`, error);
      for (const c of fresh) discarded.push({ titulo: c.titulo, funcion: c.functionId, motivo: 'el evaluador falló' });
    }
  }

  const capped = capCandidates(kept, config.exploreFindingsPerRun, config.exploreIdeasPerRun);
  for (const c of capped.cut) discarded.push({ titulo: c.titulo, funcion: c.functionId, motivo: 'fuera del tope de la corrida' });
  kept = capped.kept;

  const findings: Finding[] = [];
  for (const c of kept) {
    const id = nextFindingId([...memory.findings, ...findings]);
    let mockup: string | undefined;
    if (c.mockup && (opts.publishMockups ?? config.explorePublishMockups)) {
      mockup = await publishArtifact(c.mockup, { title: `${id} · ${c.titulo}` }).catch((error) => {
        log.error(`exploración: no se pudo publicar el mockup de ${id}`, error);
        return undefined;
      });
    }
    const patch = c.parche ? await readFile(c.parche, 'utf8').catch(() => undefined) : undefined;
    const finding: Finding = {
      id,
      tipo: c.tipo,
      titulo: c.titulo,
      funcion: c.functionId,
      senal: c.senal,
      gravedad: c.gravedad,
      charter: c.planned.charter,
      viewport: c.viewport,
      rol: c.planned.role,
      semilla: seed,
      fecha: today,
      estado: 'propuesto',
      huella: c.huella,
      ...(mockup ? { mockup } : {}),
      body: renderFindingBody(c, { functionName: c.functionName, ...(patch ? { patch } : {}) }),
    };
    await writeFinding(memoryDir, finding);
    findings.push(finding);
  }

  for (const outcome of outcomes.filter((o) => o.status === 'explorada')) {
    inventory = recordCoverage(
      inventory,
      outcome.planned.functionId,
      VIEWPORTS.map((viewport) => ({ viewport, charter: outcome.planned.charter })),
      today,
      findings.filter((f) => f.funcion === outcome.planned.functionId).map((f) => f.id),
    );
  }
  await saveInventory(memoryDir, inventory);

  const runFile = runFileName(memoryDir, runId);
  const summary: RunSummary = { runId, seed, plan, outcomes, findings, discarded, runFile, inventory: { added: refreshed.added, retired: refreshed.retired, refreshed: refreshed.refreshed } };
  await writeFile(runFile, renderRunFile(appName, summary, inventory));
  return summary;
}

export function renderRunFile(appName: string, s: RunSummary, inventory: Inventory): string {
  const name = (id: string) => inventory.funciones.find((f) => f.id === id)?.nombre ?? id;
  const lines = [
    `# Corrida ${s.runId} — ${appName}`,
    '',
    `Semilla \`${s.seed}\`. ${s.inventory.refreshed ? `Inventario refrescado (${s.inventory.added.length} funciones nuevas, ${s.inventory.retired.length} retiradas).` : 'Inventario sin cambios.'}`,
    '',
    '## Plan',
    '',
    '| Función | Motivo | Charter | Rol | Resultado |',
    '|---|---|---|---|---|',
    ...s.outcomes.map((o) => `| ${name(o.planned.functionId)} (\`${o.planned.functionId}\`) | ${o.planned.reason} | ${o.planned.charter} | ${o.planned.role} | ${o.status}${o.error ? `: ${o.error.replace(/\|/g, '/')}` : ''} |`),
    '',
  ];
  const tasks = s.outcomes.flatMap((o) => o.tareas.map((t) => ({ ...t, fn: o.planned.functionId })));
  if (tasks.length > 0) {
    lines.push('## Tareas intentadas', '', '| Función | Viewport | Tarea | Completada | Pasos |', '|---|---|---|---|---|');
    for (const t of tasks) lines.push(`| \`${t.fn}\` | ${t.viewport} | ${t.tarea.replace(/\|/g, '/')} | ${t.completada ? 'sí' : 'no'} | ${t.pasos} |`);
    lines.push('');
  }
  lines.push('## Propuestas', '');
  if (s.findings.length === 0) lines.push('Ninguna: nada de lo encontrado pasó el filtro.', '');
  for (const f of s.findings) lines.push(`- **${f.id}** (${f.tipo}, \`${f.gravedad}\`) ${f.titulo} — \`${f.funcion}\`${f.mockup ? ` · [mockup](${f.mockup})` : ''}`);
  if (s.findings.length > 0) lines.push('');
  if (s.discarded.length > 0) {
    lines.push('## Descartado', '');
    for (const d of s.discarded) lines.push(`- ${d.titulo} (\`${d.funcion}\`): ${d.motivo}`);
    lines.push('');
  }
  return lines.join('\n');
}
