import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runAgentTask = vi.fn();
vi.mock('../../core/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));
let worktreeBasePath = '';
vi.mock('../../core/repo-context.js', () => ({ activeRepo: () => ({ worktreeBasePath }) }));
const lastCommitTouching = vi.fn();
vi.mock('./plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plan.js')>()),
  lastCommitTouching: (...args: unknown[]) => lastCommitTouching(...args),
}));

import { refreshInventory } from './inventory.js';
import type { AppDefinition } from '../product-app/manifest.js';

const app = { path: 'apps/backoffice', users: [{ role: 'Sales', username: 'u', password: 'p' }] } as AppDefinition;
const known = {
  id: 'pedidos.confirmar', nombre: 'Confirmar', rutas: ['/c'], roles: ['Sales'], archivos: [],
  prioridad: 'alta' as const, cobertura: { desktop: {}, mobile: {} }, hallazgos: [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-inv-'));
  worktreeBasePath = dir;
  runAgentTask.mockReset();
  lastCommitTouching.mockReset().mockResolvedValue('sha2');
  return () => rm(dir, { recursive: true, force: true });
});

describe('refreshInventory', () => {
  it('skips the agent while the app has not changed since the last refresh', async () => {
    const memory = { dir, inventory: { actualizado: { fecha: '2026-10-01', sha: 'sha2' }, funciones: [known] }, findings: [], knowledge: '' };
    const result = await refreshInventory({ appName: 'backoffice', app, codeDir: '/code', memory, today: '2026-10-12' });
    expect(result.refreshed).toBe(false);
    expect(runAgentTask).not.toHaveBeenCalled();
  });

  it('runs the agent with the known functions and merges what it found', async () => {
    runAgentTask.mockImplementation(async (task: any) => {
      await writeFile(task.outputPath, JSON.stringify({ functions: [
        { id: 'pedidos.confirmar', nombre: 'Confirmar pedido', rutas: ['/pedidos/:id/confirmar'], roles: ['Sales'], archivos: ['a.tsx'] },
        { id: 'pedidos.surtir', nombre: 'Surtir pedido', rutas: ['/pedidos/:id/surtir'], roles: ['Sales'], archivos: ['b.tsx'] },
      ] }));
    });
    const memory = { dir, inventory: { actualizado: { fecha: '2026-10-01', sha: 'sha1' }, funciones: [known] }, findings: [], knowledge: '' };
    const result = await refreshInventory({ appName: 'backoffice', app, codeDir: '/code', memory, today: '2026-10-12' });

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      type: 'explore-inventory', checkoutDir: '/code', roles: ['Sales'], known: [{ id: 'pedidos.confirmar', nombre: 'Confirmar', rutas: ['/c'] }],
    }));
    expect(result.added).toEqual(['pedidos.surtir']);
    expect(result.inventory.actualizado).toEqual({ fecha: '2026-10-12', sha: 'sha2' });
    expect(result.inventory.funciones[0].prioridad).toBe('alta');
    expect(await readFile(join(dir, 'inventory.yml'), 'utf8')).toContain('pedidos.surtir');
  });

  it('fails loudly when the agent wrote nothing usable', async () => {
    runAgentTask.mockImplementation(async (task: any) => writeFile(task.outputPath, '{"functions": []}'));
    const memory = { dir, inventory: { funciones: [] }, findings: [], knowledge: '' };
    await expect(refreshInventory({ appName: 'backoffice', app, codeDir: '/code', memory, today: '2026-10-12' })).rejects.toThrow(/ninguna función/);
  });
});
