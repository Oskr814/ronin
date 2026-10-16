import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const { fichaComment, runFichaAction, FichaActionError } = await import('./dashboard-exploration-actions.js');

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
