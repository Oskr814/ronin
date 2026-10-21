import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/config.js', () => ({ config: { seedCatalogs: { dataDir: '/data/seed-catalog-data' } } }));

import { parseSeedCatalog, readSeedCatalog, saveSeedCatalog, seedEntries, seedHash } from './seed-catalog.js';
import type { AppStep } from '../product-app/manifest.js';

const tree = [
  '100644 blob aaa\tserver/db/dumps/seed_users.sql',
  '100644 blob bbb\tserver/db/migrations/0001_init.sql',
  '100644 blob ccc\tserver/src/seeds/demo.ts',
  '100644 blob ddd\tweb/src/pages/clientes.tsx',
  '100644 blob eee\tscripts/seed-tenants.ts',
  '040000 tree fff\tserver/db/dumps',
].join('\n');

describe('seedEntries', () => {
  it('finds seeds, migrations and dumps by convention', () => {
    expect(seedEntries(tree).map((e) => e.path)).toEqual([
      'server/db/dumps/seed_users.sql',
      'server/db/migrations/0001_init.sql',
      'server/src/seeds/demo.ts',
      'scripts/seed-tenants.ts',
    ]);
  });

  it('takes only what the manifest declares, whole directories or single files', () => {
    expect(seedEntries(tree, ['./server/db/dumps/', 'scripts/seed-tenants.ts']).map((e) => e.path)).toEqual([
      'server/db/dumps/seed_users.sql',
      'scripts/seed-tenants.ts',
    ]);
  });

  it('does not take a sibling that only shares the prefix', () => {
    expect(seedEntries('100644 blob a\tserver/db/dumps2/x.sql', ['server/db/dumps'])).toEqual([]);
  });
});

describe('seedHash', () => {
  const entries = seedEntries(tree);
  const steps: AppStep[] = [{ compose: 'up' }, { run: 'psql -f /dumps/seed_users.sql' }, { start: 'vite', name: 'web' }];

  it('does not depend on the order of the files', () => {
    expect(seedHash([...entries].reverse(), steps)).toBe(seedHash(entries, steps));
  });

  it('changes with a seed file', () => {
    const changed = entries.map((e, i) => (i === 0 ? { ...e, blob: 'zzz' } : e));
    expect(seedHash(changed, steps)).not.toBe(seedHash(entries, steps));
  });

  it('changes with a run step, and only a run step', () => {
    expect(seedHash(entries, [...steps, { run: 'psql -f /dumps/seed_orders.sql' }])).not.toBe(seedHash(entries, steps));
    expect(seedHash(entries, [...steps, { start: 'api', name: 'api' }])).toBe(seedHash(entries, steps));
  });
});

describe('parseSeedCatalog', () => {
  it('keeps a YAML with entities', () => {
    expect(parseSeedCatalog('\nclientes:\n  total: 8\n')).toBe('clientes:\n  total: 8');
  });

  it('rejects an empty or scalar one, and invalid YAML', () => {
    expect(() => parseSeedCatalog('')).toThrow(/vacío/);
    expect(() => parseSeedCatalog('nada')).toThrow(/vacío/);
    expect(() => parseSeedCatalog('a: [')).toThrow();
  });

  it('rejects one too big to hand every prompt', () => {
    expect(() => parseSeedCatalog(`x: "${'a'.repeat(70 * 1024)}"`)).toThrow(/KB/);
  });
});

describe('saveSeedCatalog / readSeedCatalog', () => {
  it('writes it with its header as comments, and leaves no temporary file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-catalog-'));
    const path = join(dir, 'repo', 'app', 'abc.yaml');
    await saveSeedCatalog(path, 'clientes:\n  total: 8', 'repo · app\nPR #1');
    expect(await readSeedCatalog(path)).toBe('# repo · app\n# PR #1\nclientes:\n  total: 8');
    expect(readdirSync(join(dir, 'repo', 'app'))).toEqual(['abc.yaml']);
  });

  it('reads nothing when there is no catalog', async () => {
    expect(await readSeedCatalog('/nonexistent/abc.yaml')).toBeNull();
  });
});
