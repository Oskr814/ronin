import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
vi.mock('./config.js', () => ({ config: {} }));
const app = { path: 'apps/backoffice', homePath: '/pedidos', viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844, isMobile: true } } };
vi.mock('./app-manifest.js', () => ({ loadAppDefinition: async () => app }));
const appDown = vi.hoisted(() => vi.fn());
vi.mock('./app-runtime.js', () => ({
  appUp: async () => ({ baseUrl: 'http://127.0.0.1:5173', ctx: { ports: {}, port: { web: 5173 } } }),
  appDown: (...a: unknown[]) => appDown(...a),
}));
vi.mock('./app-browser.js', () => ({ loginAllUsers: async () => ({ Sales: '/s/Sales.json' }), renderHtmlToPng: vi.fn() }));
const runAgentTask = vi.hoisted(() => vi.fn());
vi.mock('./agent-task.js', () => ({ runAgentTask: (...a: unknown[]) => runAgentTask(...a) }));
const publishEvidence = vi.hoisted(() => vi.fn());
vi.mock('./evidence-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./evidence-store.js')>()),
  publishEvidence: (...a: unknown[]) => publishEvidence(...a),
}));
vi.mock('./exploration-inventory.js', () => ({ explorationOutDir: () => join(base, 'out') }));
vi.mock('./exploration-run.js', () => ({ ensureCleanCheckout: async () => {}, mcpServer: () => ({ command: 'mcp', args: [] }), originsOf: () => [] }));

import { redoAfterImages } from './exploration-redo.js';
import { ensureMemoryDir, loadMemory, writeFinding } from './exploration-memory.js';

const memoryDir = () => join(base, 'memory');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-redo-'));
  runAgentTask.mockReset();
  publishEvidence.mockReset().mockResolvedValue('abc123');
  appDown.mockReset();
  await ensureMemoryDir(memoryDir());
  await writeFinding(memoryDir(), {
    id: 'F-0002', tipo: 'hallazgo', titulo: 'Búsqueda', funcion: 'f', senal: 'bug', gravedad: 'bug', charter: 'camino-feliz', viewport: 'desktop',
    rol: 'Sales', semilla: 1, fecha: '2026-10-12', estado: 'propuesto', huella: 'f|x|y',
    body: '## Búsqueda\n\n### Propuesta\n\nAvisar\n\n**Después**: viejo\n\n<img src="old" alt="viejo" width="720">\n',
  });
  return () => rm(base, { recursive: true, force: true });
});

describe('redoAfterImages', () => {
  it('redoes the after on the running app and swaps it into the finding', async () => {
    runAgentTask.mockImplementation(async (task: any) => {
      await mkdir(dirname(join(task.outDir, 'desktop/despues.png')), { recursive: true });
      await writeFile(join(task.outDir, 'desktop/despues.png'), 'img');
      await writeFile(task.outputPath, JSON.stringify({ imagen: 'desktop/despues.png', nota: 'Agregar alineado' }));
    });

    const done = await redoAfterImages({ appName: 'backoffice', codeDir: '/code', memoryDir: memoryDir(), requests: [{ findingId: 'F-0002', instruction: 'alinear' }, { findingId: 'F-0404', instruction: 'x' }] });

    expect(done).toEqual(['F-0002']);
    const task = runAgentTask.mock.calls[0][0];
    expect(task).toMatchObject({ type: 'explore-redo-after', role: 'Sales', viewport: 'desktop', findingId: 'F-0002', instruction: 'alinear' });
    expect(JSON.parse(await readFile(task.mcpConfigPath, 'utf8').catch(() => '{}'))).toEqual({});
    const [, files] = publishEvidence.mock.calls[0];
    expect(files[0].path).toMatch(/^backoffice\/redo\/F-0002\/despues-\d+\.png$/);
    const finding = (await loadMemory(memoryDir())).findings[0];
    expect(finding.id).toBe('F-0002');
    const body = await readFile(join(memoryDir(), 'findings', 'F-0002-busqueda.md'), 'utf8');
    expect(body).toContain(`**Después**: Agregar alineado\n\n<img src="https://github.com/redmotos/shoppingcart/blob/abc123/${files[0].path}?raw=true"`);
    expect(body).not.toContain('src="old"');
    expect(appDown).toHaveBeenCalledWith('/code');
  });
});
