import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// "Desarrollar ya" on a finding of the exploration PR (#379): flow.ts's
// developNow, with GitHub and the PR's branch stubbed and the memory on disk.

let base = '';
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/tienda', productRepoPath: '/repo', worktreeBasePath: base }) }));
vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main', exploreTimezone: 'America/Tegucigalpa' } }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
const processed = new Set<number>();
vi.mock('@platform/state/processed-comments.js', () => ({
  isProcessed: async (c: { id: number }) => processed.has(c.id),
  markProcessed: async (c: { id: number }) => void processed.add(c.id),
}));
const replyToComment = vi.fn();
const listIssuesWithLabel = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  listIssuesWithLabel: (...args: unknown[]) => listIssuesWithLabel(...args),
}));
vi.mock('@platform/agents/agent-task.js', () => ({}));
vi.mock('./run.js', () => ({}));
vi.mock('./inventory.js', () => ({ explorationOutDir: () => base }));
const readBranchFile = vi.fn();
vi.mock('./review.js', () => ({ readBranchFile: (...args: unknown[]) => readBranchFile(...args) }));
const ensureFindingIssue = vi.fn();
const commitAndPush = vi.fn();
const upsertExplorationPr = vi.fn();
vi.mock('./pr.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr.js')>()),
  ensureBatchWorktree: async () => base,
  ensureFindingIssue: (...args: unknown[]) => ensureFindingIssue(...args),
  commitAndPush: (...args: unknown[]) => commitAndPush(...args),
  upsertExplorationPr: (...args: unknown[]) => upsertExplorationPr(...args),
}));

const { developNow, developRequest } = await import('./flow.js');
const { ensureMemoryDir, memoryDirFor, parseFinding, serializeFinding, writeFinding } = await import('./memory.js');

const PR = { number: 840, headRefName: 'ronin/exploration/2026-10-14' } as any;
const finding = (overrides: Record<string, unknown> = {}) => ({
  id: 'F-0007', tipo: 'hallazgo', titulo: 'Doble toque duplica el pedido', funcion: 'pedidos.confirmar', senal: 'bug', gravedad: 'bug',
  charter: 'interrupciones', viewport: 'mobile', rol: 'Sales', semilla: 1, fecha: '2026-10-14', estado: 'propuesto', huella: 'h', body: '## Doble toque\n\nx', ...overrides,
}) as any;
const PATH = 'docs/exploration/backoffice/findings/F-0007-doble-toque-duplica-el-pedido.md';
const comment = (id: number, body: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'review', body, path: PATH, authorLogin: 'persona', reactionsEyes: 0, createdAt: '', ...extra }) as any;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-develop-'));
  processed.clear();
  replyToComment.mockReset().mockResolvedValue(undefined);
  listIssuesWithLabel.mockReset().mockResolvedValue([]);
  readBranchFile.mockReset();
  ensureFindingIssue.mockReset().mockResolvedValue({ number: 77, created: true });
  commitAndPush.mockReset().mockResolvedValue(true);
  upsertExplorationPr.mockReset().mockResolvedValue(840);
  await ensureMemoryDir(memoryDirFor(base, 'backoffice'));
  await writeFinding(memoryDirFor(base, 'backoffice'), finding());
  return () => rm(base, { recursive: true, force: true });
});

describe('developRequest', () => {
  it('reads the fixed words, with or without context, and nothing else', () => {
    expect(developRequest('Desarrollar ya.')).toBe('');
    expect(developRequest('Desarrollar ya: es urgente\n\nlo pidió un cliente')).toBe('es urgente\n\nlo pidió un cliente');
    expect(developRequest('¿Lo podemos desarrollar ya?')).toBeNull();
    expect(developRequest('Rechazo esta ficha: no')).toBeNull();
  });
});

describe('developNow', () => {
  it('opens the finding’s issue now, marks it approved with its issue, commits and answers', async () => {
    await developNow(PR, '2026-10-14', [comment(5, 'Desarrollar ya: lo reportó un cliente')], true);
    const [app, sent, url, opts] = ensureFindingIssue.mock.calls[0];
    expect([app, sent.id, url]).toEqual(['backoffice', 'F-0007', `https://github.com/acme/tienda/blob/main/${PATH}`]);
    expect(opts.note).toBe('Se mandó a desarrollar desde el PR de exploración #840, antes de aprobarlo, a pedido de persona.\n\nContexto: lo reportó un cliente');
    const saved = parseFinding(await readFile(join(base, PATH), 'utf8'));
    expect(saved).toMatchObject({ estado: 'aprobado', issue: 77, revisor: 'persona' });
    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(upsertExplorationPr).toHaveBeenCalledWith('2026-10-14', base);
    expect(replyToComment).toHaveBeenCalledWith(840, { id: 5, kind: 'review' }, 'Abrí #77 y me lo asigné: lo empiezo en el próximo tick. Al aprobar el PR, esta ficha no abre otro.');
    expect(processed.has(5)).toBe(true);
  });

  it('while a run writes the branch, opens the issue from the PR’s branch and leaves the rest for later', async () => {
    readBranchFile.mockResolvedValue(serializeFinding(finding()));
    await developNow(PR, '2026-10-14', [comment(5, 'Desarrollar ya.')], false);
    expect(readBranchFile.mock.calls[0][1]).toBe(PR.headRefName);
    expect(ensureFindingIssue).toHaveBeenCalledTimes(1);
    expect(replyToComment.mock.calls[0][2]).toContain('La ficha queda aprobada cuando termine la exploración que está corriendo.');
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(processed.has(5)).toBe(false);

    // Once the run is over: the same issue, found by its key, and no second answer.
    ensureFindingIssue.mockResolvedValue({ number: 77, created: false });
    await developNow(PR, '2026-10-14', [comment(5, 'Desarrollar ya.')], true);
    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(parseFinding(await readFile(join(base, PATH), 'utf8'))).toMatchObject({ estado: 'aprobado', issue: 77 });
    expect(processed.has(5)).toBe(true);
  });

  it('says so, and opens nothing, for a finding rejected or with its issue already', async () => {
    await writeFinding(memoryDirFor(base, 'backoffice'), finding({ estado: 'rechazado', motivo: 'no' }));
    await developNow(PR, '2026-10-14', [comment(5, 'Desarrollar ya.')], true);
    expect(ensureFindingIssue).not.toHaveBeenCalled();
    expect(replyToComment.mock.calls[0][2]).toContain('F-0007 está rechazada');
    expect(processed.has(5)).toBe(true);
  });

  it('ignores replies, other comments, ronin’s own and those already done', async () => {
    processed.add(9);
    await developNow(PR, '2026-10-14', [
      comment(5, 'Desarrollar ya.', { inReplyToId: 1 }),
      comment(6, 'Rechazo esta ficha: no'),
      comment(7, 'Desarrollar ya.', { authorLogin: 'ronin-agent' }),
      comment(9, 'Desarrollar ya.'),
    ], true);
    expect(listIssuesWithLabel).not.toHaveBeenCalled();
    expect(ensureFindingIssue).not.toHaveBeenCalled();
  });
});
