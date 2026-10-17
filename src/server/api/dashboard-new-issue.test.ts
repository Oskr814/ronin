import { describe, expect, it, vi, beforeEach } from 'vitest';

const createIssue = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('./github-as-user.js', () => ({
  createIssue: (...args: unknown[]) => createIssue(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
}));

const { commandComment, createFromDashboard, NewIssueError, parseNewIssue } = await import('./dashboard-new-issue.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };
const SESSION = { login: 'Oskr814', token: 'gho_x' };

beforeEach(() => {
  createIssue.mockReset().mockResolvedValue({ number: 950, url: 'https://github.com/acme/product/issues/950' });
  commentOnIssue.mockReset().mockResolvedValue({ id: 1, url: 'c' });
});

describe('parseNewIssue', () => {
  it('keeps a title and a body, and what to do after', () => {
    expect(parseNewIssue({ title: '  Exportar a Excel ', body: 'Detalle\n', after: 'assign' }, [])).toEqual({ title: 'Exportar a Excel', body: 'Detalle', after: 'assign' });
    expect(parseNewIssue({ title: 'x' }, [])).toEqual({ title: 'x', body: '', after: 'none' });
  });

  it('needs a title, a known next step and, for /spike or /spec, one of the apps', () => {
    expect(() => parseNewIssue({ title: ' ' }, [])).toThrow(NewIssueError);
    expect(() => parseNewIssue({ title: 'x', after: 'merge' }, [])).toThrow('No sé qué hacer');
    expect(() => parseNewIssue({ title: 'x', after: 'spike', app: 'otra' }, ['backoffice'])).toThrow('backoffice');
    expect(() => parseNewIssue({ title: 'x', after: 'spec' }, [])).toThrow('no hay apps');
    expect(parseNewIssue({ title: 'x', after: 'spike', app: 'backoffice', instruction: ' mirá\n el checkout ' }, ['backoffice'])).toMatchObject({ app: 'backoffice', instruction: 'mirá el checkout' });
  });
});

describe('createFromDashboard', () => {
  it('creates it as the person, assigned to ronin when asked', async () => {
    const done = await createFromDashboard(ENTRY, SESSION, { title: 't', body: 'b', after: 'assign' }, 'ronin-agent');
    expect(createIssue).toHaveBeenCalledWith('gho_x', 'acme/product', { title: 't', body: 'b', assignees: ['ronin-agent'] });
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(done).toEqual({ id: 'acme/product#950', number: 950, url: 'https://github.com/acme/product/issues/950' });
  });

  it('asks for /spike or /spec with a comment as the person', async () => {
    const issue = { title: 't', body: '', after: 'spec' as const, app: 'backoffice', instruction: 'con permisos' };
    await createFromDashboard(ENTRY, SESSION, issue, 'ronin-agent');
    expect(createIssue).toHaveBeenCalledWith('gho_x', 'acme/product', { title: 't', body: '' });
    expect(commentOnIssue).toHaveBeenCalledWith('gho_x', 'acme/product', 950, '@ronin-agent /spec backoffice con permisos');
    expect(commandComment('ronin-agent', { ...issue, after: 'spike', instruction: undefined })).toBe('@ronin-agent /spike backoffice');
  });
});
