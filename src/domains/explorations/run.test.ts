import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let base = '';
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => ({ worktreeBasePath: base, productRepo: 'o/r', productRepoPath: '/repo' }) }));
vi.mock('@platform/config/config.js', () => ({
  config: { exploreFunctionsPerRun: 3, exploreFindingsPerRun: 5, exploreIdeasPerRun: 1, explorePublishEvidence: true, claudeCommand: 'claude', claudeConfigDir: '' },
}));
const app = {
  path: 'apps/backoffice',
  steps: [],
  baseUrl: 'http://127.0.0.1:{{port.web}}',
  homePath: '/pedidos',
  users: [{ role: 'Sales', username: 's', password: 'p', notes: 'bodega usa el teléfono' }],
  login: [],
  viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844, isMobile: true } },
};
vi.mock('../product-app/manifest.js', () => ({ loadAppDefinition: async () => app }));
const appDown = vi.fn();
vi.mock('../product-app/runtime.js', () => ({
  appUp: async (dir: string) => ({ appName: 'backoffice', app, dir, baseUrl: 'http://127.0.0.1:5173', ctx: { ports: { web: { '80': 4000 } }, port: { web: 5173 }, compose: '', dir }, stateDir: '/s' }),
  appDown: (...args: unknown[]) => appDown(...args),
  checkoutAgent: async () => null,
  checkoutGit: async () => '',
  isAgentCheckout: async () => false,
}));
const renderHtmlToPng = vi.fn();
vi.mock('../product-app/browser.js', () => ({
  loginAllUsers: async () => {
    await mkdir(join(base, 'state', 'auth'), { recursive: true });
    await writeFile(join(base, 'state', 'auth', 'Sales.json'), '{}');
    return { Sales: join(base, 'state', 'auth', 'Sales.json') };
  },
  renderHtmlToPng: (...args: unknown[]) => renderHtmlToPng(...args),
}));
const publishEvidence = vi.fn();
vi.mock('../product-app/evidence-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../product-app/evidence-store.js')>()),
  publishEvidence: (...args: unknown[]) => publishEvidence(...args),
}));
vi.mock('./plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plan.js')>()),
  changedFunctions: async () => new Set<string>(),
  riskByFunction: async () => ({}),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }),
}));
const fnFixture = (id: string) => ({ id, nombre: `Nombre ${id}`, rutas: [`/${id}`], roles: ['Sales'], archivos: [], prioridad: 'normal', cobertura: { desktop: {}, mobile: {} }, hallazgos: [] });
vi.mock('./inventory.js', () => ({
  explorationOutDir: () => join(base, 'exploration-out'),
  refreshInventory: async ({ memory }: any) => ({ inventory: memory.inventory, added: [], retired: [], refreshed: false }),
}));

const runAgentTask = vi.fn();
vi.mock('@platform/agents/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));

import { runExploration } from './run.js';
import { ClaudeUsageLimitError } from '@platform/claude/claude-runner.js';
import { loadMemory, saveInventory, writeFinding, ensureMemoryDir } from './memory.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    tipo: 'hallazgo',
    titulo: 'Confirmar no avisa que el pedido excede el crédito',
    senal: 'bug',
    gravedad: 'lenta',
    viewport: 'mobile',
    huella: 'pedidos.confirmar|credito-excedido|sin-aviso',
    pasos: ['Abrir un pedido', 'Confirmar'],
    observado: 'Nada',
    esperado: 'Un aviso',
    evidencia: [{ tipo: 'consola', detalle: '400 en /Orders/Confirm' }],
    propuesta: 'Mostrar el aviso',
    ...overrides,
  };
}

let memoryDir: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-run-'));
  memoryDir = join(base, 'memory');
  await ensureMemoryDir(memoryDir);
  await saveInventory(memoryDir, { funciones: [fnFixture('pedidos.confirmar'), fnFixture('pedidos.surtir')] as any });
  runAgentTask.mockReset();
  publishEvidence.mockReset().mockResolvedValue('abc123');
  renderHtmlToPng.mockReset().mockImplementation(async (_html: string, png: string) => writeFile(png, 'png'));
  appDown.mockReset();
  return () => rm(base, { recursive: true, force: true });
});

// files: what each function's explorer leaves in its output dir, by function id.
function agentBehaviour(results: Record<string, unknown>, verdicts: (candidates: Array<{ titulo: string }>) => unknown, files: Record<string, string[]> = {}) {
  runAgentTask.mockImplementation(async (task: any) => {
    if (task.type === 'explore-function') {
      const result = results[task.fn.id];
      if (result instanceof Error) throw result;
      for (const file of files[task.fn.id] ?? []) {
        await mkdir(dirname(join(task.outDir, file)), { recursive: true });
        await writeFile(join(task.outDir, file), 'img');
      }
      await writeFile(task.outputPath, JSON.stringify(result));
    } else if (task.type === 'explore-focus') {
      await mkdir(dirname(task.outputPath), { recursive: true });
      await writeFile(task.outputPath, JSON.stringify(results['@focus'] ?? { funciones: [] }));
    } else if (task.type === 'explore-evaluate') {
      const candidates = JSON.parse(await readFile(task.candidatesPath, 'utf8'));
      await writeFile(task.outputPath, JSON.stringify(verdicts(candidates)));
    }
  });
}

describe('runExploration out of Claude quota (#382)', () => {
  const keep = (candidates: unknown[]) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) });
  const found = { tareas: [], candidatos: [candidate()] };

  it('starts no more functions and keeps what was found for the next run, which evaluates it', async () => {
    await saveInventory(memoryDir, { funciones: [fnFixture('pedidos.confirmar'), fnFixture('pedidos.surtir'), fnFixture('pedidos.anular')] as any });
    agentBehaviour({ 'pedidos.confirmar': found, 'pedidos.surtir': new ClaudeUsageLimitError('limit') }, keep);
    const first = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { functions: ['pedidos.confirmar', 'pedidos.surtir', 'pedidos.anular'] } });
    expect(first.outcomes.map((o) => [o.status, o.error])).toEqual([['explorada', undefined], ['fallo', 'sin cuota de Claude'], ['omitida', undefined]]);
    expect(runAgentTask.mock.calls.map(([t]: any) => t.type)).toEqual(['explore-function', 'explore-function']);
    expect(first.findings).toEqual([]);
    expect(first.discarded).toEqual([]);
    expect(first.deferred).toEqual([{ titulo: candidate().titulo, funcion: 'pedidos.confirmar' }]);
    expect(await readFile(first.runFile, 'utf8')).toContain('## Esperan a la próxima corrida');

    runAgentTask.mockReset();
    agentBehaviour({ 'pedidos.anular': { tareas: [], candidatos: [] } }, keep);
    const next = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-13', seed: 9, focus: { functions: ['pedidos.anular'] } });
    expect(next.findings.map((f) => [f.funcion, f.semilla, f.charter])).toEqual([['pedidos.confirmar', 7, first.plan.functions[0].charter]]);
    expect(next.deferred).toEqual([]);

    // Consumed: a third run has nothing left to evaluate.
    runAgentTask.mockReset();
    agentBehaviour({ 'pedidos.anular': { tareas: [], candidatos: [] } }, keep);
    await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-14', seed: 11, focus: { functions: ['pedidos.anular'] } });
    expect(runAgentTask.mock.calls.map(([t]: any) => t.type)).toEqual(['explore-function']);
  });

  it('keeps the candidates when it is the evaluator that runs out', async () => {
    agentBehaviour({ 'pedidos.confirmar': found, 'pedidos.surtir': { tareas: [], candidatos: [] } }, () => { throw new ClaudeUsageLimitError('limit'); });
    const run = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });
    expect(run.deferred).toHaveLength(1);
    expect(run.discarded).toEqual([]);
  });

  it('still discards what the evaluator couldn’t see for any other failure', async () => {
    agentBehaviour({ 'pedidos.confirmar': found, 'pedidos.surtir': { tareas: [], candidatos: [] } }, () => { throw new Error('boom'); });
    const run = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });
    expect(run.deferred).toEqual([]);
    expect(run.discarded.map((d) => d.motivo)).toEqual(['el evaluador falló']);
  });
});

describe('runExploration with a focus (#376)', () => {
  const keep = (candidates: unknown[]) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) });

  it('explores what the request is about, tells each explorer what to look at, and links the findings to the issue', async () => {
    agentBehaviour(
      {
        '@focus': { funciones: [{ id: 'pedidos.surtir', charter: 'cambio-de-dispositivo', encargo: 'Revisar cuánto ocupa cada campo en mobile' }] },
        'pedidos.surtir': { tareas: [], candidatos: [candidate({ titulo: 'Campos muy altos', huella: 'pedidos.surtir|campos|altos' })] },
      },
      keep,
    );
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { text: '# Compactar\n\nLos campos ocupan mucho', issue: 31 } });

    const focus = runAgentTask.mock.calls.find(([t]: any) => t.type === 'explore-focus')![0] as any;
    expect(focus).toMatchObject({ request: '# Compactar\n\nLos campos ocupan mucho', allowNew: true, max: 3 });
    expect(focus.functions.map((f: { id: string }) => f.id)).toEqual(['pedidos.confirmar', 'pedidos.surtir']);
    const explored = runAgentTask.mock.calls.filter(([t]: any) => t.type === 'explore-function').map(([t]: any) => t);
    expect(explored).toHaveLength(1);
    expect(explored[0]).toMatchObject({ fn: { id: 'pedidos.surtir' }, charter: 'cambio-de-dispositivo', focus: { request: '# Compactar\n\nLos campos ocupan mucho', encargo: 'Revisar cuánto ocupa cada campo en mobile' } });
    expect(summary.plan.functions[0].reason).toBe('foco');
    expect(summary.findings[0].origen).toBe(31);
    expect((await loadMemory(memoryDir)).findings[0].origen).toBe(31);
    expect(await readFile(summary.runFile, 'utf8')).toContain('Con foco en el pedido de #31.');
  });

  it('explores nothing, and never brings the app up, when nothing fits', async () => {
    agentBehaviour({ '@focus': { funciones: [], motivo: 'es de otra app' } }, keep);
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { text: 'la facturación', issue: 31 } });
    expect(summary.unfocused).toBe('es de otra app');
    expect(summary.outcomes).toEqual([]);
    expect(appDown).not.toHaveBeenCalled();
    expect(await readFile(summary.runFile, 'utf8')).toContain('No exploré ninguna función: es de otra app.');
  });

  it('explores the functions picked by hand without asking an agent', async () => {
    agentBehaviour({ 'pedidos.surtir': { tareas: [], candidatos: [] } }, keep);
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { functions: ['pedidos.surtir'] } });
    expect(runAgentTask.mock.calls.map(([t]: any) => t.type)).toEqual(['explore-function']);
    expect(summary.plan.functions.map((p) => [p.functionId, p.reason])).toEqual([['pedidos.surtir', 'elegida']]);
  });

  it('with picked functions and words, lets the words choose only among them, and adds no new one', async () => {
    agentBehaviour({ '@focus': { funciones: [{ id: 'nueva.cosa', nombre: 'Nueva', rutas: ['/n'], encargo: 'x' }] } }, keep);
    await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { functions: ['pedidos.surtir'], text: 'en mobile' } });
    const focus = runAgentTask.mock.calls.find(([t]: any) => t.type === 'explore-focus')![0] as any;
    expect(focus).toMatchObject({ allowNew: false, max: 1, functions: [{ id: 'pedidos.surtir' }] });
    expect((await loadMemory(memoryDir)).inventory.funciones.map((f) => f.id)).toEqual(['pedidos.confirmar', 'pedidos.surtir']);
  });

  it('adds to the inventory a function the request names that it lacks', async () => {
    agentBehaviour({
      '@focus': { funciones: [{ id: 'pedidos.notas', nombre: 'Notas del pedido', rutas: ['/pedidos/:id/notas'], roles: ['Sales'], encargo: 'x' }] },
      'pedidos.notas': { tareas: [], candidatos: [] },
    }, keep);
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, focus: { text: 'las notas' } });
    expect(summary.inventory.added).toEqual(['pedidos.notas']);
    const notas = (await loadMemory(memoryDir)).inventory.funciones.find((f) => f.id === 'pedidos.notas')!;
    expect(Object.values(notas.cobertura.mobile)).toEqual(['2026-10-12']);
  });
});

describe('runExploration', () => {
  it('explores each planned function, keeps what the evaluator keeps and writes the memory', async () => {
    agentBehaviour(
      {
        'pedidos.confirmar': {
          tareas: [{ viewport: 'desktop', tarea: 'Confirmar', completada: true, pasos: 5 }],
          candidatos: [candidate({ evidencia: [{ tipo: 'screenshot', detalle: 'mobile/aviso.png', nota: 'sin aviso' }, { tipo: 'screenshot', detalle: 'mobile/falta.png' }] })],
        },
        'pedidos.surtir': { tareas: [], candidatos: [candidate({ tipo: 'idea', titulo: 'Escanear el código al surtir', huella: 'pedidos.surtir|escanear|menos-tipeo', despues: { imagen: 'despues/idea.html', nota: 'con escáner' } })] },
      },
      (candidates) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) }),
      // mobile/falta.png is reported but was never taken.
      { 'pedidos.confirmar': ['mobile/aviso.png'], 'pedidos.surtir': ['despues/idea.html'] },
    );

    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });

    expect(summary.outcomes.map((o) => o.status)).toEqual(['explorada', 'explorada']);
    expect(summary.findings.map((f) => [f.id, f.tipo, f.funcion])).toEqual(
      expect.arrayContaining([['F-0001', 'hallazgo', 'pedidos.confirmar'], ['F-0002', 'idea', 'pedidos.surtir']]),
    );
    const [repoDir, files] = publishEvidence.mock.calls[0];
    // From the shared repo, never the checkout.
    expect(repoDir).toBe('/repo');
    const byId = Object.fromEntries(summary.findings.map((f) => [f.tipo, f.id]));
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual([
      `backoffice/2026-10-12-7/${byId.hallazgo}/antes-1.png`,
      `backoffice/2026-10-12-7/${byId.idea}/despues.png`,
    ]);
    const idea = summary.findings.find((f) => f.tipo === 'idea')!;
    expect(idea.body).toContain(`**Después**: con escáner\n\n<img src="https://github.com/o/r/blob/abc123/backoffice/2026-10-12-7/${idea.id}/despues.png?raw=true"`);
    expect(summary.findings.find((f) => f.tipo === 'hallazgo')!.body).toContain('**Antes**: sin aviso');

    const memory = await loadMemory(memoryDir);
    expect(memory.findings).toHaveLength(2);
    const confirmar = memory.inventory.funciones.find((f) => f.id === 'pedidos.confirmar')!;
    expect(Object.values(confirmar.cobertura.desktop)).toEqual(['2026-10-12']);
    expect(Object.values(confirmar.cobertura.mobile)).toEqual(['2026-10-12']);
    expect(confirmar.hallazgos).toEqual(['F-0001']);
    expect(await readFile(summary.runFile, 'utf8')).toContain('| Confirmar | sí | 5 |');
    expect(appDown).toHaveBeenCalledWith('/code');

    const explore = runAgentTask.mock.calls.find(([t]: any) => t.type === 'explore-function')![0] as any;
    expect(explore).toMatchObject({ role: 'Sales', roleNotes: 'bodega usa el teléfono', baseUrl: 'http://127.0.0.1:5173', homePath: '/pedidos', seed: 7 });
    const mcp = JSON.parse(await readFile(explore.mcpConfigPath, 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['desktop', 'mobile']);
    // The login, copied into the function's own output dir.
    expect(mcp.mcpServers.mobile.args).toEqual(expect.arrayContaining(['--device', 'iPhone 13', '--storage-state', join(explore.outDir, 'auth', 'Sales.json')]));
    expect(mcp.mcpServers.desktop.args.join(' ')).toContain('http://127.0.0.1:4000');
  });

  it('still writes the findings, describing their screenshots, when the push fails', async () => {
    publishEvidence.mockRejectedValue(new Error('push rechazado'));
    agentBehaviour(
      { 'pedidos.confirmar': { tareas: [], candidatos: [candidate({ evidencia: [{ tipo: 'screenshot', detalle: 'a.png', nota: 'sin aviso' }] })] }, 'pedidos.surtir': { tareas: [], candidatos: [] } },
      (candidates) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) }),
      { 'pedidos.confirmar': ['a.png'] },
    );
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].body).toContain('- captura: sin aviso');
    expect(summary.findings[0].body).not.toContain('<img');
  });

  it('publishes nothing for a dry run', async () => {
    agentBehaviour(
      { 'pedidos.confirmar': { tareas: [], candidatos: [candidate({ evidencia: [{ tipo: 'screenshot', detalle: 'a.png' }] })] }, 'pedidos.surtir': { tareas: [], candidatos: [] } },
      (candidates) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) }),
      { 'pedidos.confirmar': ['a.png'] },
    );
    await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2, publishEvidence: false });
    expect(publishEvidence).not.toHaveBeenCalled();
  });

  it('drops repeats of the memory before the evaluator, and what the evaluator discards', async () => {
    await writeFinding(memoryDir, {
      id: 'F-0001', tipo: 'hallazgo', titulo: 'Ya rechazado', funcion: 'pedidos.confirmar', senal: 'bug', gravedad: 'bug', charter: 'camino-feliz',
      viewport: 'desktop', rol: 'Sales', semilla: 1, fecha: '2026-10-01', estado: 'rechazado', huella: 'pedidos.confirmar|credito-excedido|sin-aviso', motivo: 'ya cubierto', body: 'x',
    });
    agentBehaviour(
      {
        'pedidos.confirmar': { tareas: [], candidatos: [candidate(), candidate({ titulo: 'Otro', huella: 'pedidos.confirmar|busqueda|lenta' })] },
        'pedidos.surtir': { tareas: [], candidatos: [candidate({ titulo: 'De gusto', huella: 'pedidos.surtir|color|feo' })] },
      },
      (candidates) => ({ veredictos: candidates.map((c, index) =>
        c.titulo === 'Otro' ? { index, veredicto: 'mantener', motivo: 'ok', gravedad: 'bloquea' } : { index, veredicto: 'descartar', motivo: 'es de gusto' }) }),
    );

    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });

    expect(summary.findings.map((f) => [f.id, f.titulo, f.gravedad])).toEqual([['F-0002', 'Otro', 'bloquea']]);
    expect(summary.discarded.map((d) => d.motivo)).toEqual(['repite F-0001', 'evaluador: es de gusto']);
  });

  it('keeps going when one function fails, and publishes nothing if the evaluator fails', async () => {
    agentBehaviour(
      { 'pedidos.confirmar': new Error('timeout'), 'pedidos.surtir': { tareas: [], candidatos: [candidate({ huella: 'pedidos.surtir|x|y' })] } },
      () => { throw new Error('no'); },
    );
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });
    expect(summary.outcomes.map((o) => o.status).sort()).toEqual(['explorada', 'fallo']);
    expect(summary.findings).toEqual([]);
    expect(summary.discarded.at(-1)!.motivo).toBe('el evaluador falló');
    expect(appDown).toHaveBeenCalled();
  });

  it('stops before a function when told to, keeping what was already explored', async () => {
    agentBehaviour({ 'pedidos.confirmar': { tareas: [], candidatos: [] }, 'pedidos.surtir': { tareas: [], candidatos: [] } }, () => ({ veredictos: [] }));
    let calls = 0;
    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2, shouldContinue: () => calls++ === 0 });
    expect(summary.outcomes.map((o) => o.status)).toEqual(['explorada', 'omitida']);
  });
});
