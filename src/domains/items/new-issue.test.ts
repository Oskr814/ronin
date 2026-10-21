import { describe, expect, it, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const createIssue = vi.fn();
const commentOnIssue = vi.fn();
vi.mock('../../platform/github/github-as-user.js', () => ({
  createIssue: (...args: unknown[]) => createIssue(...args),
  commentOnIssue: (...args: unknown[]) => commentOnIssue(...args),
}));

const { commandComment, createFromDashboard, NewIssueError, parseNewIssue, repoAppPaths } = await import('./new-issue.js');

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

describe('parseNewIssue with Linear', () => {
  const planning = { projects: [{ id: 'p1', name: 'Catálogos' }], cycles: [{ id: 'c17', number: 17, startsAt: '', endsAt: '', current: true }], people: [] };

  it("keeps a project and a cycle of the repo's planning, and refuses others", () => {
    expect(parseNewIssue({ title: 'x', projectId: 'p1', cycleId: 'c17' }, [], planning)).toMatchObject({ projectId: 'p1', cycleId: 'c17' });
    expect(() => parseNewIssue({ title: 'x', projectId: 'otro' }, [], planning)).toThrow('proyecto');
    expect(() => parseNewIssue({ title: 'x', cycleId: 'c1' }, [], planning)).toThrow('ciclo');
    expect(() => parseNewIssue({ title: 'x', projectId: 'p1' }, [])).toThrow('proyecto');
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

describe('repoAppPaths', () => {
  const manifest = (apps: string[]) => JSON.stringify({ apps: Object.fromEntries(apps.map((a) => [a, { path: `apps/${a}`, steps: [{ run: 'true' }], baseUrl: 'http://127.0.0.1:1', users: [{ role: 'admin', username: 'admin', password: 'x' }], login: [{ goto: '/' }] }])) });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

  it("reads the base branch's manifest, not the checkout's, and the checkout's when the base has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ronin-apps-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'ronin.app.json'), manifest(['backoffice', 'tienda']));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'vieja');
    writeFileSync(join(dir, 'ronin.app.json'), manifest(['backoffice']));
    expect(await repoAppPaths({ ...ENTRY, productRepoPath: dir, worktreeBaseRef: 'main' })).toEqual({ backoffice: 'apps/backoffice', tienda: 'apps/tienda' });
    expect(await repoAppPaths({ ...ENTRY, productRepoPath: dir, worktreeBaseRef: 'no-existe' })).toEqual({ backoffice: 'apps/backoffice' });
    expect(await repoAppPaths({ ...ENTRY, productRepoPath: join(dir, 'nada') })).toEqual({});
  });
});
