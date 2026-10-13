import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main', exploreTimezone: 'America/Tegucigalpa' } }));
const gh = vi.hoisted(() => ({
  listFileReviewComments: vi.fn(),
  listIssueComments: vi.fn(),
  hasBotReaction: vi.fn(),
  createIssue: vi.fn(),
  replyToComment: vi.fn(),
  addReaction: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
  listOpenPrsByHeadPrefix: vi.fn(),
}));
vi.mock('./github.js', () => gh);
const actions = vi.hoisted(() => ({ value: [] as unknown[], tasks: [] as any[] }));
vi.mock('./agent-task.js', () => ({
  runAgentTask: async (task: { outputPath: string }) => {
    actions.tasks.push(task);
    return writeFile(task.outputPath, JSON.stringify({ acciones: actions.value }));
  },
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

function comment(id: number, findingId: string, body: string, extra: Record<string, unknown> = {}) {
  return { id, path: `docs/exploration/backoffice/findings/${findingId}-x.md`, body, authorLogin: 'Oskr814', reactionsEyes: 0, ...extra };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-feedback-'));
  vi.spyOn(process, 'cwd').mockReturnValue(base);
  for (const f of Object.values(gh)) f.mockReset();
  for (const f of Object.values(prMod)) f.mockReset();
  gh.listIssueComments.mockResolvedValue([]);
  spawn.mockReset().mockReturnValue({ pid: 1, unref: () => {} });
  actions.tasks = [];
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

describe('processExplorationPr feedback — threads and earlier conversation', () => {
  it('handles a reply inside a thread when it mentions ronin, and ignores one that does not', async () => {
    gh.listFileReviewComments.mockResolvedValue([
      comment(10, 'F-0003', 'esto no aplica', { reactionsEyes: 1 }),
      comment(11, 'F-0003', 'ronin ya respondió', { authorLogin: 'ronin-agent', inReplyToId: 10 }),
      comment(12, 'F-0003', 'coincido con lo de arriba', { authorLogin: 'otra', inReplyToId: 10 }),
      comment(13, 'F-0003', '@ronin-agent creá un issue para el endpoint', { inReplyToId: 10 }),
    ]);
    gh.hasBotReaction.mockImplementation(async (id: number) => id === 10);
    actions.value = [{ commentId: 13, accion: 'crear-issue', issue: { titulo: 'Endpoint', cuerpo: 'x' }, respuesta: 'Listo' }];

    await processExplorationPr(pr({ reviewDecision: '' }));

    expect(actions.tasks[0].comments.map((c: any) => c.commentId)).toEqual([13]);
    expect(gh.createIssue).toHaveBeenCalled();
    expect(gh.replyToComment).toHaveBeenCalledWith(794, { id: 13, kind: 'review' }, 'Listo\n\nAbrí #795.');
  });

  it('gives the agent what was said before on the same finding, across threads', async () => {
    gh.listFileReviewComments.mockResolvedValue([
      comment(20, 'F-0002', 'el botón Agregar del después está desalineado', { reactionsEyes: 1 }),
      comment(21, 'F-0002', 'propongo items-start en la fila', { authorLogin: 'ronin-agent', inReplyToId: 20 }),
      comment(22, 'F-0003', 'otra ficha', { reactionsEyes: 1 }),
      comment(30, 'F-0002', '@ronin-agent vuelve a generar el después con la corrección'),
    ]);
    gh.hasBotReaction.mockImplementation(async (id: number) => id !== 30);
    actions.value = [];

    await processExplorationPr(pr());

    const sent = actions.tasks[0].comments;
    expect(sent.map((c: any) => c.commentId)).toEqual([30]);
    expect(sent[0].conversacion).toEqual([
      { autor: 'persona', texto: 'el botón Agregar del después está desalineado', mismoHilo: false },
      { autor: 'ronin', texto: 'propongo items-start en la fila', mismoHilo: false },
    ]);
  });
});

describe('processExplorationPr feedback — general comments', () => {
  const general = (id: number, body: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'issue', body, authorLogin: 'Oskr814', reactionsEyes: 0, ...extra });

  it('rejects the findings a general comment covers, notes it in the knowledge, and answers before merging', async () => {
    gh.listFileReviewComments.mockResolvedValue([]);
    gh.listIssueComments.mockResolvedValue([
      general(40, 'sin mención, entre nosotros'),
      general(41, '@ronin-agent los de mobile se resuelven con F-0003, que no se vuelvan a proponer'),
      general(42, 'ronin respondió', { authorLogin: 'ronin-agent' }),
    ]);
    actions.value = [{
      commentId: 41,
      fichas: [{ app: 'backoffice', findingId: 'F-0002', accion: 'rechazar', motivo: 'Se resuelve con F-0003 mientras no haya soporte móvil' }],
      conocimiento: [{ app: 'backoffice', texto: 'Mientras no haya soporte móvil, no proponer arreglos de mobile' }],
      respuesta: 'Rechacé F-0002 y lo anoté',
    }];

    await processExplorationPr(pr({ reviewDecision: 'APPROVED' }));

    const task = actions.tasks[0];
    expect(task.comments).toEqual([]);
    expect(task.general.map((g: any) => g.commentId)).toEqual([41]);
    expect(task.general[0].conversacion.map((m: any) => m.texto)).toEqual(['sin mención, entre nosotros']);
    expect(task.fichas.map((f: any) => `${f.app}/${f.id}`)).toEqual(['backoffice/F-0002', 'backoffice/F-0003']);
    const memory = await loadMemory(memoryDir());
    expect(memory.findings.find((f) => f.id === 'F-0002')!.estado).toBe('rechazado');
    expect(memory.findings.find((f) => f.id === 'F-0003')!.estado).toBe('propuesto');
    expect(memory.knowledge).toContain('Mientras no haya soporte móvil, no proponer arreglos de mobile (pedido en #794)');
    expect(prMod.commitAndPush.mock.calls[0][2].description).toContain('added to the backoffice knowledge file');
    expect(gh.replyToComment).toHaveBeenCalledWith(794, { id: 41, kind: 'issue' }, 'Rechacé F-0002 y lo anoté');
    expect(gh.addReaction).toHaveBeenCalledWith(41, 'issue', 'eyes');
    expect(gh.mergePullRequest).toHaveBeenCalledWith(794);
  });

  it('skips a general comment it already reacted to', async () => {
    gh.listFileReviewComments.mockResolvedValue([]);
    gh.listIssueComments.mockResolvedValue([general(41, '@ronin-agent los de mobile no', { reactionsEyes: 1 })]);
    gh.hasBotReaction.mockResolvedValue(true);

    await processExplorationPr(pr());

    expect(actions.tasks).toHaveLength(0);
  });

  it('hands an after image asked for in a general comment to the worker, answered as a general comment', async () => {
    gh.listFileReviewComments.mockResolvedValue([]);
    gh.listIssueComments.mockResolvedValue([general(43, '@ronin-agent en F-0003 el botón quedó corrido')]);
    actions.value = [{ commentId: 43, fichas: [{ findingId: 'F-0003', accion: 'editar', rehacerDespues: 'alinear el botón' }], respuesta: 'Lo corrijo' }];

    await processExplorationPr(pr());

    const request = JSON.parse(spawn.mock.calls[0][1].at(-1));
    expect(request.redo.items).toEqual([{ app: 'backoffice', findingId: 'F-0003', instruction: 'alinear el botón', commentId: 43, kind: 'issue' }]);
  });
});

describe('exploration commit changes', async () => {
  const { runCommitChange, feedbackCommitChange, redoCommitChange, idList } = await import('./exploration-flow.js');

  it('lists a few ids and ranges many', () => {
    expect(idList(['F-0002', 'F-0001'])).toBe('F-0001, F-0002');
    expect(idList(['F-0001', 'F-0002', 'F-0003', 'F-0008'])).toBe('F-0001–F-0008');
  });

  it('describes what a run, a feedback pass and a redo changed, with fallbacks in both languages', () => {
    const run = runCommitChange('webapp', 'r1', [{ id: 'F-0001', titulo: 'El owner se elimina', gravedad: 'bug' }]);
    expect(run.description).toContain('- F-0001 [bug] El owner se elimina');
    expect(run.fallback).toEqual({ en: 'add 1 webapp finding (F-0001)', es: 'agregar 1 hallazgo de webapp (F-0001)' });

    const feedback = feedbackCommitChange(351, [
      { findingId: 'F-0003', titulo: 'Formulario', kind: 'rechazada', detail: 'ya cubierto' },
      { findingId: 'F-0005', titulo: 'Botón', kind: 'editada', detail: 'new title "x"', redo: true },
    ]);
    expect(feedback.description).toContain('- F-0005 ("Botón") edited: new title "x" (its after image will be redone)');
    expect(feedback.fallback).toEqual({ en: 'reject F-0003 and update F-0005 from PR #351 review', es: 'rechazar F-0003 y corregir F-0005 según la review del PR #351' });

    expect(redoCommitChange([{ id: 'F-0006', titulo: 'Cola' }]).fallback.en).toBe('redo the after image of F-0006');
  });
});
