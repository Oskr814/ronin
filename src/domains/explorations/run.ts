import { extname, join } from 'node:path';
import { runAgentTask } from '@platform/agents/agent-task.js';
import { explorationTask, type ExistingFindingSummary } from './prompts.js';
import { appDown, appUp } from '../product-app/index.js';
import { loginAllUsers, renderHtmlToPng } from '../product-app/index.js';
import { loadAppDefinition, type AppDefinition } from '../product-app/index.js';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { evidenceUrl, publishEvidence, type EvidenceFile } from '../product-app/index.js';
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
} from './memory.js';
import { refreshInventory, explorationOutDir } from './inventory.js';
import { changedFunctions, newSeed, planRun, riskByFunction, type ExplorationPlan, type PlannedFunction } from './plan.js';
import { capCandidates, parseFunctionResult, parseVerdicts, renderFindingBody, type Candidate, type FindingImage, type TriedTask } from './output.js';
import { host } from '@platform/host/host.js';


// One exploration run end to end — docs/DESIGN.md §11.3–11.6: refresh the
// inventory, plan, bring the app up, explore each planned function in its
// own headless session (with a desktop and a mobile browser), then dedupe,
// evaluate and cap what came back, push the screenshots of what was kept to
// the evidence branch, and write the findings, the coverage and the run file
// into the memory directory. The weekly PR flow (domains/explorations/pr.ts) commits
// the memory directory and opens the PR.

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
  // Push the kept findings' screenshots to the evidence branch (off for a
  // dry run nobody else will see).
  publishEvidence?: boolean;
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
  entorno?: boolean;
  functionId: string;
  functionName: string;
  planned: PlannedFunction;
}

export function mcpServer(app: AppDefinition, viewport: 'desktop' | 'mobile', storageState: string, outputDir: string, origins: string[]) {
  const vp = app.viewports[viewport];
  return host().browserMcp([
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
  ]);
}

export function originsOf(baseUrl: string, ports: Record<string, Record<string, number>>, named: Record<string, number>): string[] {
  const origins = new Set([new URL(baseUrl).origin]);
  for (const byTarget of Object.values(ports)) for (const port of Object.values(byTarget)) origins.add(`http://127.0.0.1:${port}`);
  for (const port of Object.values(named)) origins.add(`http://127.0.0.1:${port}`);
  return [...origins].flatMap((o) => [o, o.replace('127.0.0.1', 'localhost')]);
}

// The explorer edits code to take its "after" screenshots and is told to
// revert; this makes sure of it, so the next function starts from the base.
export async function ensureCleanCheckout(dir: string, appPath: string): Promise<void> {
  const { stdout } = await host().exec('git', ['status', '--porcelain'], { cwd: dir });
  if (!stdout.trim()) return;
  log.info(`exploración: el explorador dejó cambios en el checkout, revirtiendo:\n${stdout.trim()}`);
  await host().exec('git', ['checkout', '--', '.'], { cwd: dir });
  await host().exec('git', ['clean', '-fd', '--', appPath], { cwd: dir });
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
  await host().fs.rm(outRoot, { recursive: true, force: true });
  await host().fs.mkdir(outRoot, { recursive: true });
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
      await host().fs.mkdir(join(fnOut, 'despues'), { recursive: true });
      await host().fs.mkdir(join(fnOut, 'patches'), { recursive: true });
      const mcpConfigPath = join(fnOut, 'mcp.json');
      await host().fs.writeFile(mcpConfigPath, JSON.stringify({
        mcpServers: {
          desktop: mcpServer(app, 'desktop', authStates[planned.role], join(fnOut, 'desktop'), origins),
          mobile: mcpServer(app, 'mobile', authStates[planned.role], join(fnOut, 'mobile'), origins),
        },
      }, null, 2));
      const outputPath = join(fnOut, 'result.json');
      try {
        await runAgentTask(explorationTask({
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
        }));
        const { result, dropped } = parseFunctionResult(await host().fs.readFile(outputPath, 'utf8'), fn.id, fnOut);
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
    await host().fs.writeFile(candidatesPath, JSON.stringify(fresh.map(({ planned, ...c }, index) => ({ index, funcion: c.functionId, nombreFuncion: c.functionName, charter: planned.charter, rol: planned.role, ...c })), null, 2));
    try {
      await runAgentTask(explorationTask({ type: 'explore-evaluate', appName, checkoutDir: codeDir, candidatesPath, outputPath: verdictsPath, knowledge: memory.knowledge, existing }));
      const verdicts = parseVerdicts(await host().fs.readFile(verdictsPath, 'utf8'), fresh.length);
      for (const v of verdicts) {
        const c = fresh[v.index];
        if (v.veredicto === 'mantener') kept.push({ ...c, ...(v.gravedad && c.tipo === 'hallazgo' ? { gravedad: v.gravedad } : {}), ...(v.entorno ? { entorno: true } : {}) });
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

  const ids: string[] = [];
  for (const _ of kept) ids.push(nextFindingId([...memory.findings, ...ids.map((id) => ({ id }))]));
  const images = await publishImages({
    appName,
    app,
    codeDir,
    runId,
    outRoot,
    items: kept.map((c, i) => ({ id: ids[i], candidate: c })),
    publish: opts.publishEvidence ?? config.explorePublishEvidence,
  });

  const findings: Finding[] = [];
  for (const [i, c] of kept.entries()) {
    const id = ids[i];
    const patch = c.parche ? await host().fs.readFile(c.parche, 'utf8').catch(() => undefined) : undefined;
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
      ...(c.entorno ? { entorno: true } : {}),
      body: renderFindingBody(c, { functionName: c.functionName, ...(patch ? { patch } : {}), ...images.get(id) }),
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
  await host().fs.writeFile(runFile, renderRunFile(appName, summary, inventory));
  return summary;
}

// At most this many "before" screenshots per finding reach the team.
const MAX_BEFORE = 3;

// The kept findings' screenshots, pushed to the evidence branch in one
// commit: the "before" ones the explorer took, and the "after" — rendered to
// PNG first when the explorer drew it in HTML. Returns finding id → its
// images; empty when nothing was published (disabled or the push failed),
// and the findings then describe their screenshots in text.
async function publishImages(opts: {
  appName: string;
  app: AppDefinition;
  codeDir: string;
  runId: string;
  outRoot: string;
  items: Array<{ id: string; candidate: Candidate }>;
  publish: boolean;
}): Promise<Map<string, { antes?: FindingImage[]; despues?: FindingImage }>> {
  const result = new Map<string, { antes?: FindingImage[]; despues?: FindingImage }>();
  if (!opts.publish) return result;
  const files: EvidenceFile[] = [];
  const planned: Array<{ id: string; antes: Array<{ path: string; nota?: string }>; despues?: { path: string; nota?: string } }> = [];
  for (const { id, candidate: c } of opts.items) {
    const prefix = `${opts.appName}/${opts.runId}/${id}`;
    const before: Array<{ path: string; nota?: string }> = [];
    for (const shot of c.evidencia.filter((e) => e.tipo === 'screenshot')) {
      if (before.length >= MAX_BEFORE || !(await host().fs.exists(shot.detalle))) continue;
      const path = `${prefix}/antes-${before.length + 1}${extname(shot.detalle).toLowerCase()}`;
      files.push({ src: shot.detalle, path });
      before.push({ path, ...(shot.nota ? { nota: shot.nota } : {}) });
    }
    let after: { path: string; nota?: string } | undefined;
    if (c.despues && (await host().fs.exists(c.despues.imagen))) {
      let src = c.despues.imagen;
      if (/\.html?$/i.test(src)) {
        const png = join(opts.outRoot, `${id}-despues.png`);
        src = await renderHtmlToPng(src, png, opts.app.viewports[c.viewport]).then(() => png, (error) => {
          log.error(`exploración: no se pudo renderizar el después de ${id}`, error);
          return '';
        });
      }
      if (src) {
        const path = `${prefix}/despues${extname(src).toLowerCase()}`;
        files.push({ src, path });
        after = { path, ...(c.despues.nota ? { nota: c.despues.nota } : {}) };
      }
    }
    planned.push({ id, antes: before, ...(after ? { despues: after } : {}) });
  }
  if (files.length === 0) return result;
  const sha = await publishEvidence(opts.codeDir, files, `exploración ${opts.appName} ${opts.runId}`).catch((error) => {
    log.error('exploración: no se pudieron publicar las capturas', error);
    return undefined;
  });
  if (!sha) return result;
  for (const p of planned) {
    result.set(p.id, {
      ...(p.antes.length ? { antes: p.antes.map((a) => ({ url: evidenceUrl(sha, a.path), ...(a.nota ? { nota: a.nota } : {}) })) } : {}),
      ...(p.despues ? { despues: { url: evidenceUrl(sha, p.despues.path), ...(p.despues.nota ? { nota: p.despues.nota } : {}) } } : {}),
    });
  }
  return result;
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
  for (const f of s.findings) lines.push(`- **${f.id}** (${f.tipo}, \`${f.gravedad}\`) ${f.titulo} — \`${f.funcion}\``);
  if (s.findings.length > 0) lines.push('');
  if (s.discarded.length > 0) {
    lines.push('## Descartado', '');
    for (const d of s.discarded) lines.push(`- ${d.titulo} (\`${d.funcion}\`): ${d.motivo}`);
    lines.push('');
  }
  return lines.join('\n');
}
