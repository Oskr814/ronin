import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent' } }));

const { fichaComment, generalComment, runApprove, runFichaAction, runGeneralComment, waitingOnRonin, FichaActionError } = await import('./review-actions.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' } as any;
const PR = { number: 840, headRefName: 'ronin/exploration/2026-10-14', baseRefName: 'main' };
const SESSION = { login: 'oskr814', token: 'gho_user' };
const ficha = (id: string, estado = 'propuesto') => ({ app: 'backoffice', id, estado, path: `docs/exploration/backoffice/findings/${id}-x.md` }) as any;
const REVIEW = { fetchedAt: '', branch: PR.headRefName, base: 'main', runs: [], fichas: [ficha('F-0017'), ficha('F-0015', 'rechazado')] };
const post = vi.fn();

beforeEach(() => {
  post.mockReset().mockResolvedValue({ id: 9, url: 'https://github.com/acme/product/pull/840#discussion_r9' });
});

describe('fichaComment', () => {
  it('says in plain words what it asks for, as someone would in "Files changed"', () => {
    expect(fichaComment('rechazar', 'Muy poco probable')).toBe('Rechazo esta ficha: Muy poco probable');
    expect(fichaComment('cambios', 'Que el aviso diga el motivo', true)).toBe('Que el aviso diga el motivo\n\nTambién hay que rehacer la captura del después.');
    expect(fichaComment('cambios', 'Solo el texto')).toBe('Solo el texto');
    expect(fichaComment('issue', 'revisar los toasts de catálogos')).toBe('Abrí un issue aparte: revisar los toasts de catálogos');
    expect(fichaComment('pregunta', '¿Pasa como Sales?')).toBe('¿Pasa como Sales?');
  });
});

describe('runFichaAction', () => {
  it('comments on the finding file of the PR, as the person', async () => {
    const done = await runFichaAction(ENTRY, PR, REVIEW, SESSION, { action: 'cambios', ficha: 'backoffice/F-0017', text: '  Que el aviso diga el motivo ', redo: true }, post);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 840, 'docs/exploration/backoffice/findings/F-0017-x.md', 'Que el aviso diga el motivo\n\nTambién hay que rehacer la captura del después.');
    expect(done).toEqual({ id: 9, url: 'https://github.com/acme/product/pull/840#discussion_r9', ficha: 'backoffice/F-0017' });
  });

  it('only lets people talk on a finding already decided', async () => {
    await expect(runFichaAction(ENTRY, PR, REVIEW, SESSION, { action: 'rechazar', ficha: 'backoffice/F-0015', text: 'otra vez' }, post)).rejects.toThrow('ya está rechazada');
    await runFichaAction(ENTRY, PR, REVIEW, SESSION, { action: 'pregunta', ficha: 'backoffice/F-0015', text: '¿Por qué?' }, post);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses before commenting: unknown action or finding, no text, redo outside of changes', async () => {
    for (const request of [
      { action: 'aprobar', ficha: 'backoffice/F-0017', text: 'x' },
      { action: 'rechazar', ficha: 'backoffice/F-9999', text: 'x' },
      { action: 'rechazar', ficha: 'backoffice/F-0017', text: '   ' },
      { action: 'rechazar', ficha: 'backoffice/F-0017', text: 'x', redo: true },
    ]) await expect(runFichaAction(ENTRY, PR, REVIEW, SESSION, request, post)).rejects.toBeInstanceOf(FichaActionError);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('runGeneralComment', () => {
  it('comments on the PR as the person, mentioning ronin so the exploration flow reads it', async () => {
    expect(generalComment('los de mobile se resuelven con F-0003')).toBe('@ronin-agent los de mobile se resuelven con F-0003');
    await runGeneralComment(ENTRY, PR, SESSION, { text: ' los de mobile se resuelven con F-0003 ' }, post);
    expect(post).toHaveBeenCalledWith('gho_user', 'acme/product', 840, '@ronin-agent los de mobile se resuelven con F-0003');
    await expect(runGeneralComment(ENTRY, PR, SESSION, { text: '  ' }, post)).rejects.toBeInstanceOf(FichaActionError);
  });
});

describe('runApprove', () => {
  const c = (id: number, author: string, body = 'x', replyTo?: number) => ({ id, author, body, ...(replyTo ? { replyTo } : {}) });
  const withComments = (comments: unknown[], estado = 'propuesto') => ({ ...ficha('F-0018', estado), comments });

  it('tells which findings still wait on ronin: a new comment, or a reply that mentions it, with nothing from ronin after', () => {
    const review = { ...REVIEW, fichas: [
      withComments([c(1, 'oskr814')]),
      { ...withComments([c(2, 'oskr814'), c(3, 'ronin-agent', 'listo', 2)]), id: 'F-0019' },
      { ...withComments([c(4, 'oskr814'), c(5, 'ronin-agent', 'listo', 4), c(6, 'otra', 'de acuerdo', 4)]), id: 'F-0020' },
      { ...withComments([c(7, 'oskr814'), c(8, 'ronin-agent', 'listo', 7), c(9, 'oskr814', '@ronin-agent y el título?', 7)]), id: 'F-0021' },
      { ...withComments([c(10, 'oskr814')], 'rechazado'), id: 'F-0022' },
    ] };
    expect(waitingOnRonin(review as any).map((f) => f.id)).toEqual(['F-0018', 'F-0021']);
  });

  it('approves as the person, with the comment if there is one', async () => {
    const approve = vi.fn().mockResolvedValue({ id: 3, url: 'https://github.com/acme/product/pull/840#pullrequestreview-3' });
    const review = { ...REVIEW, fichas: [{ ...ficha('F-0017'), comments: [] }] };
    await runApprove(ENTRY, PR, review as any, SESSION, { text: ' las de catálogos primero ' }, approve);
    expect(approve).toHaveBeenCalledWith('gho_user', 'acme/product', 840, 'las de catálogos primero');
    await runApprove(ENTRY, PR, review as any, SESSION, {}, approve);
    expect(approve).toHaveBeenLastCalledWith('gho_user', 'acme/product', 840, undefined);
  });

  it('does not approve while ronin is still applying a comment', async () => {
    const approve = vi.fn();
    const review = { ...REVIEW, fichas: [{ ...ficha('F-0017'), comments: [{ id: 1, author: 'oskr814', body: 'Rechazo esta ficha: no' }] }] };
    await expect(runApprove(ENTRY, PR, review as any, SESSION, {}, approve)).rejects.toThrow('F-0017');
    expect(approve).not.toHaveBeenCalled();
  });
});
