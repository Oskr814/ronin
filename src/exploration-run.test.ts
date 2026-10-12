import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ worktreeBasePath: base, productRepo: 'o/r' }) }));
vi.mock('./config.js', () => ({
  config: { exploreFunctionsPerRun: 3, exploreFindingsPerRun: 5, exploreIdeasPerRun: 1, explorePublishMockups: true, claudeCommand: 'claude', claudeConfigDir: '' },
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
vi.mock('./app-manifest.js', () => ({ loadAppDefinition: async () => app }));
const appDown = vi.fn();
vi.mock('./app-runtime.js', () => ({
  appUp: async (dir: string) => ({ appName: 'backoffice', app, dir, baseUrl: 'http://127.0.0.1:5173', ctx: { ports: { web: { '80': 4000 } }, port: { web: 5173 }, compose: '', dir }, stateDir: '/s' }),
  appDown: (...args: unknown[]) => appDown(...args),
}));
vi.mock('./app-browser.js', () => ({ loginAllUsers: async () => ({ Sales: '/s/auth/Sales.json' }) }));
const publishArtifact = vi.fn();
vi.mock('./artifact-publisher.js', () => ({ publishArtifact: (...args: unknown[]) => publishArtifact(...args) }));
vi.mock('./exploration-plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exploration-plan.js')>()),
  changedFunctions: async () => new Set<string>(),
  riskByFunction: async () => ({}),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }),
}));
const fnFixture = (id: string) => ({ id, nombre: `Nombre ${id}`, rutas: [`/${id}`], roles: ['Sales'], archivos: [], prioridad: 'normal', cobertura: { desktop: {}, mobile: {} }, hallazgos: [] });
vi.mock('./exploration-inventory.js', () => ({
  explorationOutDir: () => join(base, 'exploration-out'),
  refreshInventory: async ({ memory }: any) => ({ inventory: memory.inventory, added: [], retired: [], refreshed: false }),
}));

const runAgentTask = vi.fn();
vi.mock('./agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));

import { runExploration } from './exploration-run.js';
import { loadMemory, saveInventory, writeFinding, ensureMemoryDir } from './exploration-memory.js';

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
  publishArtifact.mockReset().mockResolvedValue('https://claude.ai/artifact/abc');
  appDown.mockReset();
  return () => rm(base, { recursive: true, force: true });
});

function agentBehaviour(results: Record<string, unknown>, verdicts: (candidates: Array<{ titulo: string }>) => unknown) {
  runAgentTask.mockImplementation(async (task: any) => {
    if (task.type === 'explore-function') {
      const result = results[task.fn.id];
      if (result instanceof Error) throw result;
      await writeFile(task.outputPath, JSON.stringify(result));
    } else if (task.type === 'explore-evaluate') {
      const candidates = JSON.parse(await readFile(task.candidatesPath, 'utf8'));
      await writeFile(task.outputPath, JSON.stringify(verdicts(candidates)));
    }
  });
}

describe('runExploration', () => {
  it('explores each planned function, keeps what the evaluator keeps and writes the memory', async () => {
    const mockupDir = join(base, 'exploration-out', '2026-10-12-7', 'pedidos.surtir', 'mockups');
    agentBehaviour(
      {
        'pedidos.confirmar': { tareas: [{ viewport: 'desktop', tarea: 'Confirmar', completada: true, pasos: 5 }], candidatos: [candidate()] },
        'pedidos.surtir': { tareas: [], candidatos: [candidate({ tipo: 'idea', titulo: 'Escanear el código al surtir', huella: 'pedidos.surtir|escanear|menos-tipeo', mockup: 'mockups/idea.html' })] },
      },
      (candidates) => ({ veredictos: candidates.map((_, index) => ({ index, veredicto: 'mantener', motivo: 'ok' })) }),
    );
    // The idea's mockup file has to exist for the explorer to reference it.
    await mkdir(mockupDir, { recursive: true });
    await writeFile(join(mockupDir, 'idea.html'), '<html></html>');

    const summary = await runExploration({ appName: 'backoffice', codeDir: '/code', memoryDir, today: '2026-10-12', seed: 7, maxFunctions: 2 });

    expect(summary.outcomes.map((o) => o.status)).toEqual(['explorada', 'explorada']);
    expect(summary.findings.map((f) => [f.id, f.tipo, f.funcion])).toEqual(
      expect.arrayContaining([['F-0001', 'hallazgo', 'pedidos.confirmar'], ['F-0002', 'idea', 'pedidos.surtir']]),
    );
    expect(summary.findings.find((f) => f.tipo === 'idea')!.mockup).toBe('https://claude.ai/artifact/abc');

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
    expect(mcp.mcpServers.mobile.args).toEqual(expect.arrayContaining(['--device', 'iPhone 13', '--storage-state', '/s/auth/Sales.json']));
    expect(mcp.mcpServers.desktop.args.join(' ')).toContain('http://127.0.0.1:4000');
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
