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
  dir = await mkdtemp(join(tmpdir(), 'valeria-repos-test-'));
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
      { productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: undefined },
      { productRepo: 'c/d', productRepoPath: '/tmp/c', claudeConfigDir: '/home/x/.claude-c' },
    ]);
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
});
