import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let reposConfigPath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'reposConfigPath' ? reposConfigPath : undefined) }),
}));

const { loadRepos } = await import('./repos.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-repos-test-'));
  reposConfigPath = join(dir, 'repos.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadRepos', () => {
  it('loads and validates a well-formed repos.json', async () => {
    await writeFile(
      reposConfigPath,
      JSON.stringify([
        { productRepo: 'a/b', productRepoPath: '/tmp/a' },
        { productRepo: 'c/d', productRepoPath: '/tmp/c', claudeConfigDir: '/home/x/.claude-c' },
      ]),
    );

    const repos = await loadRepos();
    expect(repos).toEqual([
      { productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: undefined, worktreeBaseRef: undefined },
      { productRepo: 'c/d', productRepoPath: '/tmp/c', claudeConfigDir: '/home/x/.claude-c', worktreeBaseRef: undefined },
    ]);
  });

  it('loads worktreeBaseRef when an entry has one, e.g. a repo whose default branch is not main', async () => {
    await writeFile(
      reposConfigPath,
      JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', worktreeBaseRef: 'origin/odoo-main' }]),
    );

    const repos = await loadRepos();
    expect(repos[0].worktreeBaseRef).toBe('origin/odoo-main');
  });

  it('loads the apps to explore every night, and rejects anything but a list of names', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', explore: ['backoffice'] }]));
    expect((await loadRepos())[0].explore).toEqual(['backoffice']);

    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', explore: 'backoffice' }]));
    await expect(loadRepos()).rejects.toThrow('explore');
  });

  it("loads the repo's own concurrency, and rejects anything but a whole number from 1 to 10", async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', concurrency: 2 }]));
    expect((await loadRepos())[0].concurrency).toBe(2);
    for (const bad of [0, 11, 1.5, '2']) {
      await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', concurrency: bad }]));
      await expect(loadRepos()).rejects.toThrow('concurrency');
    }
  });

  it('throws when worktreeBaseRef is present but not a string', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', worktreeBaseRef: 42 }]));
    await expect(loadRepos()).rejects.toThrow('worktreeBaseRef');
  });

  it('throws when the file does not exist', async () => {
    await expect(loadRepos()).rejects.toThrow(`No se pudo leer ${reposConfigPath}`);
  });

  it('throws when the file is not valid JSON', async () => {
    await writeFile(reposConfigPath, '{not json');
    await expect(loadRepos()).rejects.toThrow('no es JSON válido');
  });

  it('throws when the file is an empty array', async () => {
    await writeFile(reposConfigPath, '[]');
    await expect(loadRepos()).rejects.toThrow('al menos un repo');
  });

  it('throws when an entry is missing productRepo', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepoPath: '/tmp/a' }]));
    await expect(loadRepos()).rejects.toThrow('productRepo');
  });

  it('throws when an entry is missing productRepoPath', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b' }]));
    await expect(loadRepos()).rejects.toThrow('productRepoPath');
  });

  it('throws when claudeConfigDir is present but not a string', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: 42 }]));
    await expect(loadRepos()).rejects.toThrow('claudeConfigDir');
  });

  it('throws when productRepo is duplicated across entries', async () => {
    await writeFile(
      reposConfigPath,
      JSON.stringify([
        { productRepo: 'a/b', productRepoPath: '/tmp/a' },
        { productRepo: 'c/d', productRepoPath: '/tmp/c' },
        { productRepo: 'a/b', productRepoPath: '/tmp/other' },
      ]),
    );

    await expect(loadRepos()).rejects.toThrow('tiene el repo "a/b" duplicado');
  });

  it('keeps a valid agent block and rejects a malformed one', async () => {
    const agent = { model: 'sonnet', effort: '', models: { 'external-review': 'opus' } };
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', agent }]));
    expect((await loadRepos())[0].agent).toEqual(agent);

    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', agent: { modle: 'sonnet' } }]));
    await expect(loadRepos()).rejects.toThrow(/campos desconocidos: modle/);

    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', agent: { models: { 'fix-review': 3 } } }]));
    await expect(loadRepos()).rejects.toThrow(/agent\.models/);
  });

  it('keeps a valid linear block and rejects a malformed one', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', linear: { apiKeyEnv: 'LINEAR_API_KEY_X' } }]));
    expect((await loadRepos())[0].linear).toEqual({ apiKeyEnv: 'LINEAR_API_KEY_X' });

    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', linear: { apiKey: 'lin_api_secreto' } }]));
    await expect(loadRepos()).rejects.toThrow(/campos desconocidos: apiKey/);

    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', linear: { apiKeyEnv: 'lin_api_secreto' } }]));
    await expect(loadRepos()).rejects.toThrow(/linear\.apiKeyEnv/);

    const linear = { apiKeyEnv: 'K', explorationProject: { backoffice: 'Mejoras de backoffice' } };
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', linear }]));
    expect((await loadRepos())[0].linear).toEqual(linear);
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', linear: { apiKeyEnv: 'K', explorationProject: { backoffice: '' } } }]));
    await expect(loadRepos()).rejects.toThrow(/explorationProject/);
  });

  it('keeps a valid portal block (#114) and rejects a malformed one', async () => {
    const portal = { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice', description: 'Pedidos y clientes' } }, notifyTo: ['ana@x.com', 'luis@x.com'] };
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', portal }]));
    expect((await loadRepos())[0].portal).toEqual(portal);

    for (const [bad, error] of [
      [{ apps: portal.apps }, /portal\.name/],
      [{ name: 'X', apps: {} }, /portal\.apps/],
      [{ name: 'X', apps: { backoffice: 'Backoffice' } }, /portal\.apps\.backoffice/],
      [{ name: 'X', apps: { backoffice: { name: 'B', color: 'red' } } }, /portal\.apps\.backoffice/],
      [{ ...portal, mail: {} }, /campos desconocidos: mail/],
      [{ ...portal, notifyTo: 'ana@x.com' }, /portal\.notifyTo/],
      [{ ...portal, notifyTo: [] }, /portal\.notifyTo/],
      [{ ...portal, notifyTo: ['ana@x.com, luis@x.com'] }, /portal\.notifyTo/],
    ] as const) {
      await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', portal: bad }]));
      await expect(loadRepos()).rejects.toThrow(error);
    }
  });

  it('keeps a valid deploy block (#158) and rejects a malformed one', async () => {
    for (const deploy of [{}, { prerelease: true, selective: false }]) {
      await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', deploy }]));
      expect((await loadRepos())[0].deploy).toEqual(deploy);
    }
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a' }]));
    expect((await loadRepos())[0].deploy).toBeUndefined();

    for (const [bad, error] of [
      [true, /deploy debe ser un objeto/],
      [{ selective: 'sí' }, /deploy\.selective/],
      [{ prerelease: 1 }, /deploy\.prerelease/],
      [{ workflow: 'deploy.yml' }, /campos desconocidos: workflow/],
    ] as const) {
      await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', deploy: bad }]));
      await expect(loadRepos()).rejects.toThrow(error);
    }
  });
});
