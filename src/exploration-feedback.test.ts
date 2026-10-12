import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main', exploreTimezone: 'America/Tegucigalpa' } }));
const gh = vi.hoisted(() => ({
  listFileReviewComments: vi.fn(),
  hasBotReaction: vi.fn(),
  createIssue: vi.fn(),
  replyToComment: vi.fn(),
  addReaction: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
  listOpenPrsByHeadPrefix: vi.fn(),
}));
vi.mock('./github.js', () => gh);
const actions = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('./agent-task.js', () => ({
  runAgentTask: async (task: { outputPath: string }) => writeFile(task.outputPath, JSON.stringify({ acciones: actions.value })),
}));
vi.mock('./app-runtime.js', () => ({ ensureAppWorktree: async () => '/code' }));
vi.mock('./exploration-run.js', () => ({}));
vi.mock('./exploration-redo.js', () => ({ redoAfterImages: vi.fn() }));
vi.mock('./exploration-inventory.js', () => ({ explorationOutDir: () => join(base, 'out') }));
const prMod = vi.hoisted(() => ({ commitAndPush: vi.fn(), upsertExplorationPr: vi.fn(), openFindingIssues: vi.fn() }));
vi.mock('./exploration-pr.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exploration-pr.js')>()),
  ensureBatchWorktree: async () => join(base, 'batch'),
  commitAndPush: (...a: unknown[]) => prMod.commitAndPush(...a),
  upsertExplorationPr: (...a: unknown[]) => prMod.upsertExplorationPr(...a),
  openFindingIssues: (...a: unknown[]) => prMod.openFindingIssues(...a),
}));
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawn(...a),
}));

import { processExplorationPr } from './exploration-flow.js';
import { ensureMemoryDir, loadMemory, memoryDirFor, writeFinding, type Finding } from './exploration-memory.js';

const memoryDir = () => memoryDirFor(join(base, 'batch'), 'backoffice');
const pr = (overrides: Record<string, unknown> = {}) => ({ number: 794, headRefName: 'ronin/exploration/2026-10-12', isDraft: false, reviewDecision: '', ...overrides }) as any;

function finding(id: string, titulo: string): Finding {
  return {
    id, tipo: 'hallazgo', titulo, funcion: 'pedidos.agregar', senal: 'bug', gravedad: 'bug', charter: 'camino-feliz', viewport: 'desktop',
    rol: 'Sales', semilla: 1, fecha: '2026-10-12', estado: 'propuesto', huella: `pedidos.agregar|${id}|x`,
    body: `## ${titulo}\n\n### Propuesta\n\nMostrar un aviso\n\n**Después**: botón\n\n<img src="u" alt="botón" width="720">\n`,
  };
}

function comment(id: number, findingId: string, body: string) {
  return { id, path: `docs/exploration/backoffice/findings/${findingId}-x.md`, body, authorLogin: 'Oskr814', reactionsEyes: 0 };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-feedback-'));
  vi.spyOn(process, 'cwd').mockReturnValue(base);
  for (const f of Object.values(gh)) f.mockReset();
  for (const f of Object.values(prMod)) f.mockReset();
  spawn.mockReset().mockReturnValue({ pid: 1, unref: () => {} });
  gh.createIssue.mockResolvedValue({ number: 795, url: 'u' });
  gh.replyToComment.mockResolvedValue(undefined);
  gh.addReaction.mockResolvedValue(undefined);
  prMod.commitAndPush.mockResolvedValue(true);
  await ensureMemoryDir(memoryDir());
  await writeFinding(memoryDir(), finding('F-0002', 'La búsqueda falla en silencio'));
  await writeFinding(memoryDir(), finding('F-0003', 'Cambiar de cliente pierde el pedido'));
  return () => rm(base, { recursive: true, force: true });
});

describe('processExplorationPr feedback', () => {
  it('edits a finding and hands the after image to the worker', async () => {
    gh.listFileReviewComments.mockResolvedValue([comment(11, 'F-0002', 'el botón del después está desalineado')]);
    actions.value = [{ commentId: 11, accion: 'editar', titulo: 'Un error de búsqueda parece "sin coincidencias"', propuesta: 'Mostrar el error con reintentar', rehacerDespues: 'alinear Agregar', respuesta: 'Corregí la propuesta' }];

    await processExplorationPr(pr());

    const memory = await loadMemory(memoryDir());
    const edited = memory.findings.find((f) => f.id === 'F-0002')!;
    expect(edited.titulo).toBe('Un error de búsqueda parece "sin coincidencias"');
    const files = await readdir(join(memoryDir(), 'findings'));
    expect(files.filter((f) => f.startsWith('F-0002'))).toHaveLength(1);
    const body = await readFile(join(memoryDir(), 'findings', files.find((f) => f.startsWith('F-0002'))!), 'utf8');
    expect(body).toContain('## Un error de búsqueda parece "sin coincidencias"');
    expect(body).toContain('### Propuesta\n\nMostrar el error con reintentar\n');
    expect(body).toContain('**Después**: botón');
    expect(gh.replyToComment).toHaveBeenCalledWith(794, { id: 11, kind: 'review' }, 'Corregí la propuesta');
    const request = JSON.parse(spawn.mock.calls[0][1].at(-1));
    expect(request.redo).toEqual({ prNumber: 794, batch: '2026-10-12', items: [{ app: 'backoffice', findingId: 'F-0002', instruction: 'alinear Agregar', commentId: 11 }] });
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('opens the issue a comment asks for and says its number', async () => {
    gh.listFileReviewComments.mockResolvedValue([comment(12, 'F-0003', 'creá un issue para el endpoint nuevo')]);
    actions.value = [{ commentId: 12, accion: 'crear-issue', issue: { titulo: 'Endpoint con la info mínima del cliente', cuerpo: 'Para @alguien: nombre, teléfono' }, respuesta: 'Listo' }];

    await processExplorationPr(pr());

    const [title, body, labels] = gh.createIssue.mock.calls[0];
    expect(title).toBe('Endpoint con la info mínima del cliente');
    expect(body).toContain('Para alguien: nombre, teléfono');
    expect(body).toContain('ficha F-0003 del PR de exploración #794');
    expect(labels).toEqual([]);
    expect(gh.replyToComment.mock.calls[0][2]).toBe('Listo\n\nAbrí #795.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('marks an old draft ready, and merges an approved PR into issues', async () => {
    gh.listFileReviewComments.mockResolvedValue([]);
    await processExplorationPr(pr({ isDraft: true, headRefName: 'ronin/exploration/2026-W42' }));
    expect(gh.markPullRequestReady).toHaveBeenCalledWith(794);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();

    await processExplorationPr(pr({ reviewDecision: 'APPROVED' }));
    expect(gh.mergePullRequest).toHaveBeenCalledWith(794);
    expect(prMod.openFindingIssues).toHaveBeenCalled();
  });
});
