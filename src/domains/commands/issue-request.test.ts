import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentTask = vi.fn();
vi.mock('../../platform/agents/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));

const getIssueBody = vi.fn();
const setIssueBody = vi.fn();
const replyToComment = vi.fn();
const addReaction = vi.fn();
vi.mock('../../platform/github/github.js', () => ({
  getIssueBody: (...args: unknown[]) => getIssueBody(...args),
  setIssueBody: (...args: unknown[]) => setIssueBody(...args),
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  addReaction: (...args: unknown[]) => addReaction(...args),
}));

// Done-ness lives in the local state now (processed-comments.ts, tested on
// its own); here it's still read off the 👀, as these tests set it up.
vi.mock('../../platform/state/processed-comments.js', () => ({
  markProcessed: (c: { id: number; kind: string }) => addReaction(c.id, c.kind, 'eyes'),
}));

const launchPrototypeWorker = vi.fn();
vi.mock('./prototype.js', () => ({ launchPrototypeWorker: (...args: unknown[]) => launchPrototypeWorker(...args) }));

const removeWorktree = vi.fn();
vi.mock('../../platform/git/worktree.js', () => ({ removeWorktree: (...args: unknown[]) => removeWorktree(...args) }));
vi.mock('../../platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

let outputJson = '';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined), readFile: vi.fn(async () => outputJson) };
});
vi.mock('../../platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product', worktreeBasePath: '/tmp/ronin-test' }) }));

import { nextIssueBody, parseIssueRequestResult, processIssueRequest } from './issue-request.js';

const trigger = { id: 77, kind: 'issue' as const, body: '@ronin esto aplica sobre otras vistas', reactionsEyes: 0, authorLogin: 'someone' };

beforeEach(() => {
  runAgentTask.mockReset().mockResolvedValue('');
  getIssueBody.mockReset().mockResolvedValue('Descripción original');
  setIssueBody.mockReset().mockResolvedValue(undefined);
  replyToComment.mockReset().mockResolvedValue(undefined);
  addReaction.mockReset().mockResolvedValue(undefined);
  launchPrototypeWorker.mockReset();
  removeWorktree.mockReset().mockResolvedValue(undefined);
  outputJson = '';
});

describe('parseIssueRequestResult', () => {
  it('keeps every part that is well formed', () => {
    const result = parseIssueRequestResult(JSON.stringify({
      alcance: { texto: 'Catálogos, Pedidos y Usuarios guardan sus filtros en la URL.', cambio: 'se extiende a todas las vistas con listado' },
      contexto: 'useGetUsers ya lo hace.',
      prototipo: { app: 'backoffice', instruccion: 'volver del detalle con el filtro puesto' },
      respuesta: 'Listo, amplié el alcance.',
    }));
    expect(result).toEqual({
      alcance: { texto: 'Catálogos, Pedidos y Usuarios guardan sus filtros en la URL.', cambio: 'se extiende a todas las vistas con listado' },
      contexto: 'useGetUsers ya lo hace.',
      prototipo: { app: 'backoffice', instruccion: 'volver del detalle con el filtro puesto' },
      respuesta: 'Listo, amplié el alcance.',
    });
  });

  it('drops a malformed optional part instead of failing the reply', () => {
    const result = parseIssueRequestResult(JSON.stringify({
      alcance: { texto: 'sin cambio' },
      prototipo: { app: '../../etc', instruccion: 'x' },
      contexto: '   ',
      respuesta: 'ok',
    }));
    expect(result).toEqual({ respuesta: 'ok' });
  });

  it('fails without a reply', () => {
    expect(() => parseIssueRequestResult('{"alcance": {"texto": "a", "cambio": "b"}}')).toThrow('respuesta');
    expect(() => parseIssueRequestResult('[]')).toThrow();
  });
});

describe('nextIssueBody', () => {
  it('leaves the body alone when the result asks for neither scope nor investigation', () => {
    expect(nextIssueBody('Original', { respuesta: 'ok' }, { commentUrl: 'u', date: 'd' })).toBe('Original');
  });
});

describe('processIssueRequest', () => {
  it('writes the scope into the freshest body, replies and reacts', async () => {
    outputJson = JSON.stringify({ alcance: { texto: 'Nuevo alcance', cambio: 'se amplía' }, respuesta: 'Amplié el alcance.' });

    await processIssueRequest({ issueNumber: 820, trigger });

    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({ type: 'issue-request', issueNumber: 820, trigger }));
    const body = setIssueBody.mock.calls[0][1] as string;
    expect(setIssueBody.mock.calls[0][0]).toBe(820);
    expect(body.startsWith('Descripción original')).toBe(true);
    expect(body).toContain('Nuevo alcance');
    expect(body).toContain('https://github.com/acme/product/issues/820#issuecomment-77');
    expect(replyToComment).toHaveBeenCalledWith(820, trigger, 'Amplié el alcance.');
    expect(addReaction).toHaveBeenCalledWith(77, 'issue', 'eyes');
    expect(launchPrototypeWorker).not.toHaveBeenCalled();
  });

  it('launches the prototype and says so in the reply, without touching the body', async () => {
    outputJson = JSON.stringify({ prototipo: { app: 'backoffice', instruccion: 'el modal' }, respuesta: 'Va.' });

    await processIssueRequest({ issueNumber: 820, trigger });

    expect(setIssueBody).not.toHaveBeenCalled();
    expect(launchPrototypeWorker).toHaveBeenCalledWith({ repo: 'acme/product', issueNumber: 820, appName: 'backoffice', instruction: 'el modal', commentId: 77 });
    expect(replyToComment.mock.calls[0][2]).toContain('Arranco el prototipo en `backoffice`');
  });

  it('answers and reacts when the run fails, so it is not retried every tick', async () => {
    runAgentTask.mockRejectedValue(new Error('timeout del agente'));

    await processIssueRequest({ issueNumber: 820, trigger });

    expect(setIssueBody).not.toHaveBeenCalled();
    expect(replyToComment.mock.calls[0][2]).toContain('No pude atender este pedido: timeout del agente');
    expect(addReaction).toHaveBeenCalledWith(77, 'issue', 'eyes');
    expect(removeWorktree).toHaveBeenCalledWith('ronin/820/request');
  });
});
