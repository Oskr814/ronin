import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '../../core/config.js';
import type { RepoEntry } from '../../core/repo-context.js';

// GitHub as the person, Linear and its queue are stand-ins: what's checked
// is what gets created, with what, and that nothing is created twice.
const createIssue = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('./github-as-user.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github-as-user.js')>()),
  createIssue: (...args: unknown[]) => createIssue(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
}));
const createProject = vi.fn();
const teamContext = vi.fn();
vi.mock('../../core/linear-api.js', () => ({
  linearKey: (e: RepoEntry) => (e.linear ? 'lin_key' : null),
  teamContext: () => teamContext(),
  createProject: (...args: unknown[]) => createProject(...args),
}));
const queueLinearAssignment = vi.fn();
const applyLinearSoon = vi.fn();
vi.mock('../../core/linear-assign.js', () => ({
  queueLinearAssignment: (...args: unknown[]) => queueLinearAssignment(...args),
  applyLinearSoon: (...args: unknown[]) => applyLinearSoon(...args),
}));

const { createMeeting, getMeeting, updateMeeting, extractPasted } = await import('../../meetings/index.js');
const { GithubUserError } = await import('./github-as-user.js');
const { approveMeeting, discardMeeting, origin } = await import('./dashboard-meetings-approve.js');

const SC = 'redmotos/shoppingcart';
const ENTRY = { productRepo: SC, productRepoPath: '/tmp/sc', linear: { apiKeyEnv: 'X' } } as unknown as RepoEntry;
const SESSION = { login: 'valeria', token: 'gho_v' };
const CTX = {
  team: 'RED', teamId: 't1',
  projects: [{ id: 'p-seg', name: 'Seguridad carrito de compras', status: 'In Progress', statusType: 'started' }],
  cycles: [{ id: 'c17', number: 17, startsAt: '2026-10-12', endsAt: '2026-10-19', current: true }, { id: 'c18', number: 18, startsAt: '2026-10-19', endsAt: '2026-10-26', current: false }],
  people: [{ id: 'u-abdias', name: 'Abdias V.' }],
};
const issue = (id: string, title: string, extra = {}) => ({ id, title, body: `## Qué\n${title}`, why: '', cites: [1], ...extra });

async function meeting() {
  const m = await createMeeting({ repo: SC, by: 'Oskr814', title: 'Seguimiento', at: '2026-10-16T21:00:00.000Z', notes: extractPasted('Devoluciones de mayoristas, con nota de crédito en Odoo, y un reporte para bodega.') });
  await updateMeeting(m.number, (x) => {
    x.status = 'review';
    x.proposals = {
      summary: '', at: '',
      projects: [{ id: 'p1', name: 'Devoluciones', description: 'Registrar devoluciones.', why: '', cites: [1], lead: 'Abdias V.', issues: [issue('p1-1', 'Modelo de devolución', { cycle: 'current' }), issue('p1-2', 'Pantalla de devolución')] }],
      issues: [issue('i1', 'Exportar pedidos', { project: 'Seguridad carrito de compras', cycle: 'next' })],
      comments: [{ id: 'c1', issue: 915, issueTitle: 'Buscar sin tilde', body: 'Prioridad acordada.', why: '', cites: [1], cycle: 'next' }],
      discarded: [],
    };
  });
  return m.number;
}

let next = 930;
beforeEach(async () => {
  await rm(config.meetings.dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
  next = 930;
  teamContext.mockResolvedValue(CTX);
  createProject.mockResolvedValue({ id: 'p-new', url: 'https://linear.app/x/project/p-new' });
  createIssue.mockImplementation(async () => ({ number: next, url: `https://github.com/${SC}/issues/${next++}` }));
  commentOnIssue.mockResolvedValue({ id: 1, url: `https://github.com/${SC}/issues/915#issuecomment-1` });
  queueLinearAssignment.mockResolvedValue(undefined);
});

describe('approveMeeting', () => {
  it('creates what was chosen, with the edits, as the person, and its Linear project and cycles', async () => {
    const n = await meeting();
    const out = await approveMeeting(ENTRY, n, SESSION, [
      { id: 'p1', title: 'Devoluciones mayoristas', lead: 'Abdias V.' },
      { id: 'p1-1' },
      { id: 'i1', title: 'Exportar a Excel la lista de pedidos', cycle: '' },
      { id: 'c1', body: 'Se acordó darle prioridad.' },
    ]);
    expect(out).toEqual({ created: 4, failed: 0, status: 'done' });
    const footer = origin((await getMeeting(n))!, 'valeria');
    expect(footer).toContain('De la reunión R-1, "Seguimiento" (16 de octubre de 2026): lo propuso ronin y lo aprobó valeria en el tablero.');
    expect(createProject).toHaveBeenCalledWith('lin_key', { name: 'Devoluciones mayoristas', description: 'Registrar devoluciones.', content: `Registrar devoluciones.\n\n${footer}`, teamId: 't1', leadId: 'u-abdias' });
    expect(createIssue.mock.calls).toEqual([
      ['gho_v', SC, { title: 'Modelo de devolución', body: `## Qué\nModelo de devolución\n\n${footer}` }],
      ['gho_v', SC, { title: 'Exportar a Excel la lista de pedidos', body: `## Qué\nExportar pedidos\n\n${footer}` }],
    ]);
    expect(commentOnIssue).toHaveBeenCalledWith('gho_v', SC, 915, `Se acordó darle prioridad.\n\n${footer}`);
    expect(queueLinearAssignment.mock.calls).toEqual([
      [{ number: 930, projectId: 'p-new', cycleId: 'c17' }],
      // The person took the cycle off; the project stays.
      [{ number: 931, projectId: 'p-seg' }],
      [{ number: 915, cycleId: 'c18' }],
    ]);
    expect(applyLinearSoon).toHaveBeenCalledWith(ENTRY);
    const after = (await getMeeting(n))!;
    expect(after.status).toBe('done');
    expect(after.results).toMatchObject({
      p1: { ok: true, url: 'https://linear.app/x/project/p-new', projectId: 'p-new', by: 'valeria' },
      'p1-1': { ok: true, number: 930 },
      i1: { ok: true, number: 931 },
      c1: { ok: true, number: 915 },
    });
    expect(after.results).not.toHaveProperty('p1-2');
    expect(after.events.at(-1)).toMatchObject({ kind: 'approved', by: 'valeria', created: 4, failed: 0 });
  });

  it('keeps what failed to try again, and never creates twice what was created', async () => {
    const n = await meeting();
    createIssue.mockImplementationOnce(async () => ({ number: 930, url: 'u930' })).mockRejectedValueOnce(new Error('GitHub respondió 502.'));
    const first = await approveMeeting(ENTRY, n, SESSION, [{ id: 'p1' }, { id: 'p1-1' }, { id: 'p1-2' }]);
    expect(first).toEqual({ created: 2, failed: 1, status: 'review' });
    expect((await getMeeting(n))!.results!['p1-2']).toMatchObject({ ok: false, error: 'GitHub respondió 502.' });
    createIssue.mockClear();
    createProject.mockClear();
    // Again: only the one that failed; its project, already made, isn't chosen again.
    const second = await approveMeeting(ENTRY, n, SESSION, [{ id: 'p1-1' }, { id: 'p1-2' }]);
    expect(second).toEqual({ created: 1, failed: 0, status: 'done' });
    expect(createProject).not.toHaveBeenCalled();
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][2].title).toBe('Pantalla de devolución');
    expect(queueLinearAssignment).toHaveBeenLastCalledWith({ number: 930, projectId: 'p-new' });
  });

  it("says why it can't, before creating anything", async () => {
    const n = await meeting();
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'p1-1' }])).rejects.toThrow('Los issues de "Devoluciones" van dentro del proyecto: márcalo también.');
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'zz' }])).rejects.toThrow('ya no existe');
    await expect(approveMeeting(ENTRY, n, SESSION, [])).rejects.toThrow('Marca al menos una');
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'i1', title: '  ' }])).rejects.toThrow('Un título quedó vacío');
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'i1', cycle: 'ayer' }])).rejects.toThrow('Un ciclo no se entiende');
    await updateMeeting(n, (m) => { m.status = 'done'; });
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'i1' }])).rejects.toMatchObject({ status: 409 });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('stops when GitHub no longer takes the session, keeping what was done', async () => {
    const n = await meeting();
    commentOnIssue.mockRejectedValueOnce(new GithubUserError('Tu sesión de GitHub venció.', true));
    await expect(approveMeeting(ENTRY, n, SESSION, [{ id: 'i1' }, { id: 'c1' }])).rejects.toBeInstanceOf(GithubUserError);
    const after = (await getMeeting(n))!;
    expect(after.status).toBe('review');
    expect(after.results).toEqual({ i1: expect.objectContaining({ ok: true }) });
  });

  it('without Linear, creates the issues and no project', async () => {
    const n = await meeting();
    const out = await approveMeeting({ ...ENTRY, linear: undefined } as RepoEntry, n, SESSION, [{ id: 'p1' }, { id: 'c1' }]);
    expect(out).toEqual({ created: 1, failed: 1, status: 'review' });
    expect((await getMeeting(n))!.results!.p1).toMatchObject({ ok: false, error: 'El repo no usa Linear: no se pueden crear proyectos.' });
    expect(queueLinearAssignment).not.toHaveBeenCalled();
  });
});

describe('discardMeeting', () => {
  it('sets aside a meeting under review, once', async () => {
    const n = await meeting();
    await discardMeeting(n, 'valeria');
    expect((await getMeeting(n))!).toMatchObject({ status: 'discarded', events: expect.arrayContaining([expect.objectContaining({ kind: 'discarded', by: 'valeria' })]) });
    await expect(discardMeeting(n, 'valeria')).rejects.toThrow('ya no se puede descartar');
  });
});
