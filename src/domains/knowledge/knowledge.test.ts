import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withActiveRepo } from '@platform/agents/repo-context.js';
import {
  knowledgeForRun, knowledgeIndex, knowledgeOn, knowledgePath, LIMITS, mergeLearned, parseLearned, prune, readKnowledge, saveLearned, saveResolved, staleIds,
  type Knowledge, type Screen,
} from './knowledge.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const NOW = new Date('2026-10-24T12:00:00Z');
const empty = (): Knowledge => ({ screens: [], traps: [], resolved: [] });
const screen = (over: Partial<Screen> = {}): Screen => ({
  id: 'S1', route: '/orders/:id', name: 'Detalle del pedido', components: ['web/src/orders/Detail.tsx'], endpoints: ['GET /api/orders/{id}'], entities: ['Order'],
  files: ['web/src/orders/Detail.tsx'], commit: 'c0', updatedAt: NOW.toISOString(), usedAt: NOW.toISOString(), ...over,
});

// A product repo with two commits: Detail.tsx changes in the second.
function repo(): { path: string; first: string } {
  const path = mkdtempSync(join(tmpdir(), 'ronin-knowledge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ronin@example.com');
  git('config', 'user.name', 'ronin');
  execFileSync('mkdir', ['-p', join(path, 'web/src/orders')]);
  writeFileSync(join(path, 'web/src/orders/Detail.tsx'), 'v1');
  writeFileSync(join(path, 'web/src/orders/List.tsx'), 'v1');
  git('add', '.');
  git('commit', '-qm', 'uno');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(path, 'web/src/orders/Detail.tsx'), 'v2');
  git('commit', '-qam', 'dos');
  return { path, first };
}
const inRepo = <T>(path: string, fn: () => Promise<T>) => withActiveRepo({ productRepo: 'redmotos/shoppingcart', productRepoPath: path, worktreeBaseRef: 'main' }, fn);

describe('what an agent learned (#412)', () => {
  it('takes screens with their route and name, and traps with their text; nothing else', () => {
    const learned = parseLearned({
      usadas: ['S2', 4],
      pantallas: [
        { id: 'S1', ruta: '/orders/:id', nombre: 'Detalle del pedido', componentes: ['web/src/orders/Detail.tsx'], endpoints: ['GET /api/orders/{id}'], entidades: ['Order'], llegar: { rol: 'Admin', viewport: 'desktop', pasos: 'Pedidos → el primero' }, captura: 1 },
        { ruta: '/sin-nombre' },
      ],
      trampas: [{ texto: 'El seed no trae pedidos anulados: se crean por SQL.', archivos: ['db/seed.sql'] }, { archivos: [] }],
      borrar: ['T9'],
    });
    expect(learned).toEqual({
      used: ['S2'],
      screens: [{ id: 'S1', route: '/orders/:id', name: 'Detalle del pedido', components: ['web/src/orders/Detail.tsx'], endpoints: ['GET /api/orders/{id}'], entities: ['Order'], files: ['web/src/orders/Detail.tsx'], reach: { role: 'Admin', viewport: 'desktop', steps: 'Pedidos → el primero' }, capture: 1 }],
      traps: [{ text: 'El seed no trae pedidos anulados: se crean por SQL.', files: ['db/seed.sql'] }],
      removed: ['T9'],
    });
    expect(parseLearned({ pantallas: [], usadas: [] })).toBeUndefined();
    expect(parseLearned('x')).toBeUndefined();
  });

  it('folds into the bitácora: by id or by route, the script of its capture, what it used, what it found wrong', () => {
    const k: Knowledge = { ...empty(), screens: [screen({ usedAt: '2026-10-20T00:00:00Z' }), screen({ id: 'S2', route: '/orders', name: 'Pedidos', usedAt: '2026-10-20T00:00:00Z' })], traps: [{ id: 'T1', text: 'mal', files: [], commit: 'c0', updatedAt: '', usedAt: NOW.toISOString() }] };
    const script = JSON.stringify({ capturas: [{ n: 1, navegador: 'admin-desktop', pasos: [{ ir: '/orders/2' }] }] });
    mergeLearned(k, {
      used: ['S2'],
      screens: [
        { route: '/ORDERS/:id', name: 'Detalle', components: [], endpoints: [], entities: [], files: ['web/src/orders/Detail.tsx'], capture: 1 },
        { route: '/clients', name: 'Clientes', components: [], endpoints: [], entities: [], files: [] },
      ],
      traps: [{ text: 'Hay que prender el flag de catálogos.', files: [] }],
      removed: ['T1'],
    }, 'c1', { script, now: NOW });
    expect(k.screens.find((s) => s.id === 'S1')).toMatchObject({ name: 'Detalle', commit: 'c1', usedAt: NOW.toISOString(), reach: { script: { n: 1, navegador: 'admin-desktop', pasos: [{ ir: '/orders/2' }] } } });
    expect(k.screens.find((s) => s.id === 'S2')?.usedAt).toBe(NOW.toISOString());
    expect(k.screens.find((s) => s.id === 'S3')).toMatchObject({ route: '/clients', commit: 'c1' });
    expect(k.traps).toEqual([expect.objectContaining({ id: 'T1', text: 'Hay que prender el flag de catálogos.' })]);
  });

  it('drops what nobody used in a month, and keeps each list within its limit', () => {
    const k: Knowledge = {
      screens: [screen({ usedAt: '2026-09-01T00:00:00Z' }), ...Array.from({ length: LIMITS.screens + 5 }, (_, i) => screen({ id: `S${i + 2}`, usedAt: new Date(NOW.getTime() - i * 60_000).toISOString() }))],
      traps: [],
      resolved: Array.from({ length: LIMITS.resolved + 3 }, (_, i) => ({ request: i, summary: 's', files: [], mergedAt: new Date(NOW.getTime() - i * 60_000).toISOString() })),
    };
    prune(k, NOW);
    expect(k.screens).toHaveLength(LIMITS.screens);
    expect(k.screens.some((s) => s.id === 'S1')).toBe(false);
    expect(k.screens[0].id).toBe('S2');
    expect(k.resolved).toHaveLength(LIMITS.resolved);
    expect(k.resolved[0].request).toBe(0);
  });

  it('marks to check what is based on files that changed since, or on a commit the repo lacks', async () => {
    const { path, first } = repo();
    const k: Knowledge = { ...empty(), screens: [screen({ commit: first }), screen({ id: 'S2', files: ['web/src/orders/List.tsx'], commit: first }), screen({ id: 'S3', commit: 'f'.repeat(40) })] };
    expect([...(await inRepo(path, () => staleIds(k)))].sort()).toEqual(['S1', 'S3']);
  });

  it('gives the run an index for the prompt and the detail in its own dir, each entry saying whether to check it', async () => {
    const { path, first } = repo();
    const out = mkdtempSync(join(tmpdir(), 'ronin-knowledge-out-'));
    await inRepo(path, async () => {
      expect(await knowledgeForRun('backoffice', out)).toBeUndefined();
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
      await saveLearned('backoffice', { used: [], screens: [{ route: '/orders', name: 'Pedidos', components: [], endpoints: [], entities: [], files: ['web/src/orders/List.tsx'] }], traps: [{ text: 'El seed trae un solo cliente con catálogos.', files: [] }], removed: [] });
      await saveResolved('backoffice', { request: 12, summary: 'Enlace a la ficha del cliente', files: ['web/src/orders/Detail.tsx'], pr: 40, mergedAt: NOW.toISOString() });
      const saved = await readKnowledge('backoffice');
      expect(saved.screens[0]).toMatchObject({ id: 'S1', commit });
      // One based on an older Detail.tsx, by hand.
      saved.screens.push(screen({ id: 'S2', commit: first, usedAt: new Date(Date.now() - 24 * 3600_000).toISOString() }));
      writeFileSync(knowledgePath('backoffice'), JSON.stringify(saved));

      const run = await knowledgeForRun('backoffice', out);
      expect(run?.index).toBe([
        'Pantallas:\n- S1 Pedidos — /orders\n- S2 Detalle del pedido — /orders/:id (a verificar)',
        'Trampas:\n- T1 El seed trae un solo cliente con catálogos.',
        'Pedidos resueltos:\n- P-12 Enlace a la ficha del cliente — web/src/orders/Detail.tsx',
      ].join('\n\n'));
      expect(run?.path).toBe(join(out, 'bitacora.json'));
      const detail = JSON.parse(readFileSync(run!.path!, 'utf8')) as Knowledge;
      expect(detail.screens.find((s) => s.id === 'S2')).toMatchObject({ verificar: true });
      expect(detail.screens.find((s) => s.id === 'S1')).not.toHaveProperty('verificar');
      expect((await knowledgeForRun('backoffice'))?.path).toBeUndefined();
    });
  });

  it('keeps each app of each repo apart, in ronin’s data dir', () => {
    expect(knowledgePath('Back Office', 'RedMotos/shoppingcart')).toMatch(/knowledge-data\/redmotos-shoppingcart\/back-office\/bitacora\.json$/);
  });

  it('keeps the index within a few KB', () => {
    const k: Knowledge = { ...empty(), traps: Array.from({ length: 40 }, (_, i) => ({ id: `T${i + 1}`, text: 'x'.repeat(400), files: [], commit: 'c', updatedAt: '', usedAt: '' })) };
    expect(knowledgeIndex(k, new Set()).length).toBeLessThanOrEqual(4_000);
  });
});

describe('who uses the bitácora (#437)', () => {
  const learned = { used: [], screens: [{ route: '/orders', name: 'Pedidos', components: [], endpoints: [], entities: [], files: ['web/src/orders/List.tsx'] }], traps: [], removed: [] };
  const at = <T>(path: string, knowledge: { portalOff?: string[]; previews?: string[] } | undefined, fn: () => Promise<T>) =>
    withActiveRepo({ productRepo: 'redmotos/previews', productRepoPath: path, worktreeBaseRef: 'main', ...(knowledge ? { knowledge } : {}) }, fn);

  it('the portal unless turned off; a preview only once turned on', async () => {
    const { path } = repo();
    await at(path, undefined, async () => {
      expect(knowledgeOn('backoffice', 'portal')).toBe(true);
      expect(knowledgeOn('backoffice', 'previews')).toBe(false);
      await saveLearned('backoffice', learned, { use: 'previews' });
      expect((await readKnowledge('backoffice')).screens).toEqual([]);
    });
    await at(path, { portalOff: ['backoffice'] }, async () => {
      await saveLearned('backoffice', learned);
      expect((await readKnowledge('backoffice')).screens).toEqual([]);
    });
  });

  it('what a preview learned is on its PR’s head: to check while the base branch has other files, confirmed once it has the same', async () => {
    const { path } = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
    // The PR: List.tsx changes on a branch of its own.
    git('checkout', '-q', '-b', 'pr');
    writeFileSync(join(path, 'web/src/orders/List.tsx'), 'v2');
    git('commit', '-qam', 'pr');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    await at(path, { previews: ['backoffice'] }, async () => {
      await saveLearned('backoffice', learned, { use: 'previews', commit: head });
      expect((await readKnowledge('backoffice')).screens[0]).toMatchObject({ id: 'S1', commit: head });
      expect((await knowledgeForRun('backoffice', undefined, 'previews'))?.index).toContain('S1 Pedidos — /orders (a verificar)');
      // Squash-merged: main gets the same file in a commit of its own.
      writeFileSync(join(path, 'web/src/orders/List.tsx'), 'v2');
      git('commit', '-qam', 'squash');
      expect((await knowledgeForRun('backoffice', undefined, 'previews'))?.index).toBe('Pantallas:\n- S1 Pedidos — /orders');
    });
  });
});
