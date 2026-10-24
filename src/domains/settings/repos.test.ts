import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-repos-'));
const config = vi.hoisted(() => ({ settings: { dataDir: '' }, reposConfigPath: '', worktreeBaseRef: 'origin/main', agentModel: 'opus', agentEffort: 'high' }));
config.settings.dataDir = join(dir, 'settings');
config.reposConfigPath = join(dir, 'repos.json');
vi.mock('@platform/config/config.js', () => ({ config, taskEnvModel: () => undefined, taskEnvEffort: () => undefined, taskDefaultModel: (t: string) => (t === 'update-changelog' ? 'haiku' : undefined) }));
vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@platform/linear/linear-api.js', () => ({ linearKey: () => null, teamPlanning: async () => null }));
vi.mock('../items/new-issue.js', () => ({ repoApps: async () => ['backoffice', 'tienda'] }));

const { readSettingsLog } = await import('./settings.js');
const { editRepo, reposView } = await import('./repos.js');
const { loadRepos } = await import('@platform/config/repos.js');

const SC = 'redmotos/shoppingcart';
const file = () => JSON.parse(readFileSync(config.reposConfigPath, 'utf8'));
const edit = async (body: Record<string, unknown>) => editRepo('jefa', SC, body, await loadRepos());

beforeEach(() => {
  rmSync(config.settings.dataDir, { recursive: true, force: true });
  writeFileSync(config.reposConfigPath, JSON.stringify([
    { productRepo: SC, productRepoPath: '/sc', claudeConfigDir: '/c', extra: 'se queda', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice' } }, notifyTo: ['ana@x.com', 'luis@x.com'] } },
    { productRepo: 'Bmedical/bmedical', productRepoPath: '/bm' },
  ]));
  process.env.LINEAR_API_KEY_REDMOTOS = 'lin_x';
  process.env.ANTHROPIC_API_KEY_REDMOTOS = 'sk-ant-x';
});

describe('editRepo', () => {
  it('writes the change into repos.json, keeps what it doesn\'t touch, a copy of the previous one, and the Registro', async () => {
    await edit({ baseRef: 'origin/odoo-main' });
    await edit({ portalName: 'Red Motos HN' });
    const sc = file()[0];
    expect(sc).toMatchObject({ worktreeBaseRef: 'origin/odoo-main', extra: 'se queda', claudeConfigDir: '/c', portal: { name: 'Red Motos HN' } });
    expect(readdirSync(join(config.settings.dataDir, 'repos-json'))).toHaveLength(2);
    expect((await readSettingsLog()).map((e) => `${e.what}: ${e.from} → ${e.to}`)).toEqual([
      `Repos · ${SC} · nombre en el portal: Red Motos → Red Motos HN`,
      `Repos · ${SC} · rama base: la de .env (origin/main) → origin/odoo-main`,
    ]);
  });

  it('puts an app of ronin.app.json in the portal and takes it out, but never the last one', async () => {
    await edit({ app: { id: 'tienda', portal: true } });
    await edit({ app: { id: 'tienda', name: 'Tienda', description: 'La tienda en línea' } });
    expect(file()[0].portal.apps.tienda).toEqual({ name: 'Tienda', description: 'La tienda en línea' });
    await edit({ app: { id: 'backoffice', portal: false } });
    await expect(edit({ app: { id: 'tienda', portal: false } })).rejects.toThrow(/al menos una/);
    await expect(edit({ app: { id: 'otra', portal: true } })).rejects.toThrow(/ronin.app.json/);
    expect(Object.keys(file()[0].portal.apps)).toEqual(['tienda']);
  });

  it('turns nightly exploration, deploys, Linear and the agents on and off', async () => {
    await edit({ app: { id: 'backoffice', explore: true } });
    await edit({ deploy: { on: true, selective: true } });
    await edit({ linear: 'LINEAR_API_KEY_REDMOTOS' });
    await edit({ app: { id: 'backoffice', project: 'Mejoras de backoffice' } });
    await edit({ agent: { model: 'sonnet' } });
    expect(file()[0]).toMatchObject({ explore: ['backoffice'], deploy: { selective: true }, linear: { apiKeyEnv: 'LINEAR_API_KEY_REDMOTOS', explorationProject: { backoffice: 'Mejoras de backoffice' } }, agent: { model: 'sonnet' } });
    await edit({ app: { id: 'backoffice', explore: false } });
    await edit({ deploy: { on: false } });
    await edit({ linear: null });
    await edit({ agent: { model: null } });
    const sc = file()[0];
    expect(sc.explore).toBeUndefined();
    expect(sc.deploy).toBeUndefined();
    expect(sc.linear).toBeUndefined();
    expect(sc.agent).toBeUndefined();
  });

  it('turns the nightly exploration off without taking the app out of the exploration (#426)', async () => {
    await expect(edit({ app: { id: 'backoffice', nightly: false } })).rejects.toThrow(/primero prende/);
    await edit({ app: { id: 'backoffice', explore: true } });
    await edit({ app: { id: 'backoffice', nightly: false } });
    expect(file()[0]).toMatchObject({ explore: ['backoffice'], exploreNightlyOff: ['backoffice'] });
    await edit({ app: { id: 'backoffice', nightly: true } });
    expect(file()[0].exploreNightlyOff).toBeUndefined();
    await edit({ app: { id: 'backoffice', nightly: false } });
    await edit({ app: { id: 'backoffice', explore: false } });
    expect(file()[0].explore).toBeUndefined();
    expect(file()[0].exploreNightlyOff).toBeUndefined();
  });

  it("sets the automatic deploy's tag pattern (#353), only with picked PRs and a pattern that works", async () => {
    await edit({ deploy: { on: true } });
    await expect(edit({ deploy: { auto: 'v{major}.{minor}.{patch+1}' } })).rejects.toThrow(/Solo lo que elijas/);
    await expect(edit({ deploy: { selective: true, auto: 'v{major}.{minor}.{patch}' } })).rejects.toThrow(/subir algún número/);
    await edit({ deploy: { selective: true, auto: ' v{major}.{minor}.{patch+1} ' } });
    expect(file()[0].deploy).toEqual({ selective: true, auto: { tag: 'v{major}.{minor}.{patch+1}' } });
    await edit({ deploy: { auto: null } });
    expect(file()[0].deploy).toEqual({ selective: true });
  });

  it('sets how many tasks of the repo run at once, and back to the general one', async () => {
    await edit({ concurrency: 2 });
    expect(file()[0].concurrency).toBe(2);
    await edit({ concurrency: null });
    expect(file()[0].concurrency).toBeUndefined();
    await expect(edit({ concurrency: 0 })).rejects.toThrow(/entre 1 y 10/);
    await expect(edit({ concurrency: 2.5 })).rejects.toThrow(/entre 1 y 10/);
  });

  it("turns the auto-merge of ronin's PRs off and on, writing only the false", async () => {
    await edit({ autoMerge: false });
    expect(file()[0].autoMerge).toBe(false);
    await edit({ autoMerge: true });
    expect(file()[0].autoMerge).toBeUndefined();
    await expect(edit({ autoMerge: 'no' })).rejects.toThrow(/sí o no/);
  });

  it('refuses what isn\'t valid, and writes nothing then', async () => {
    const before = readFileSync(config.reposConfigPath, 'utf8');
    await expect(edit({ linear: 'LINEAR_API_KEY_NO_EXISTE' })).rejects.toThrow(/no está en .env/);
    await expect(edit({ agent: { model: 'gpt' } })).rejects.toThrow(/modelo/);
    await expect(edit({ baseRef: 'rama con espacios' })).rejects.toThrow(/rama base/);
    await expect(edit({ notifyTo: ['ana@x.com', 'otro@x.com'] })).rejects.toThrow(/solo se quitan/);
    await expect(editRepo('jefa', 'otro/repo', { baseRef: 'x' }, await loadRepos())).rejects.toThrow(/no está en repos.json/);
    expect(readFileSync(config.reposConfigPath, 'utf8')).toBe(before);
  });

  it('only takes addresses off portal.notifyTo', async () => {
    await edit({ notifyTo: ['luis@x.com'] });
    expect(file()[0].portal.notifyTo).toEqual(['luis@x.com']);
    await edit({ notifyTo: [] });
    expect(file()[0].portal.notifyTo).toBeUndefined();
  });
});

describe('editRepo — the API fallback (#421)', () => {
  it('turns it on with a key of .env and the default cap, changes its model and cap, and turns it off', async () => {
    await edit({ apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS' } });
    expect(file()[0].apiFallback).toEqual({ apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS', maxUsd: 20 });
    await edit({ apiFallback: { model: 'haiku' } });
    await edit({ apiFallback: { maxUsd: 35 } });
    expect(file()[0].apiFallback).toEqual({ apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS', model: 'haiku', maxUsd: 35 });
    expect((await loadRepos())[0].apiFallback).toEqual({ apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS', model: 'haiku', maxUsd: 35 });
    await edit({ apiFallback: null });
    expect(file()[0].apiFallback).toBeUndefined();
    expect((await readSettingsLog()).map((e) => `${e.what}: ${e.from} → ${e.to}`)).toEqual([
      `Repos · ${SC} · respaldo por API: ANTHROPIC_API_KEY_REDMOTOS, haiku, tope $35 → sin respaldo`,
      `Repos · ${SC} · respaldo por API: ANTHROPIC_API_KEY_REDMOTOS, haiku, tope $20 → ANTHROPIC_API_KEY_REDMOTOS, haiku, tope $35`,
      `Repos · ${SC} · respaldo por API: ANTHROPIC_API_KEY_REDMOTOS, sonnet, tope $20 → ANTHROPIC_API_KEY_REDMOTOS, haiku, tope $20`,
      `Repos · ${SC} · respaldo por API: sin respaldo → ANTHROPIC_API_KEY_REDMOTOS, sonnet, tope $20`,
    ]);
  });

  it('takes only a key of .env, a real model and a cap above zero', async () => {
    await expect(edit({ apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY_NO_EXISTE' } })).rejects.toThrow(/no está en .env/);
    await expect(edit({ apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY' } })).rejects.toThrow(/no está en .env/);
    await expect(edit({ apiFallback: { maxUsd: 10 } })).rejects.toThrow(/primero elige la variable/);
    await edit({ apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS' } });
    await expect(edit({ apiFallback: { model: 'gpt' } })).rejects.toThrow(/modelo no existe/);
    await expect(edit({ apiFallback: { maxUsd: 0 } })).rejects.toThrow(/mayor que 0/);
    expect(file()[0].apiFallback).toEqual({ apiKeyEnv: 'ANTHROPIC_API_KEY_REDMOTOS', maxUsd: 20 });
  });
});

describe('reposView', () => {
  it('lists each repo with its apps, and the Linear keys of .env by name only', async () => {
    const view = await reposView(await loadRepos()) as { linearKeys: string[]; repos: Array<{ repo: string; apps: Array<{ id: string; portal: boolean; inManifest: boolean }> }> };
    expect(view.linearKeys).toContain('LINEAR_API_KEY_REDMOTOS');
    expect(JSON.stringify(view)).not.toContain('lin_x');
    expect((view as unknown as { anthropicKeys: string[] }).anthropicKeys).toEqual(['ANTHROPIC_API_KEY_REDMOTOS']);
    expect(JSON.stringify(view)).not.toContain('sk-ant-x');
    expect(view.repos[0].apps.map((a) => [a.id, a.portal])).toEqual([['backoffice', true], ['tienda', false]]);
  });
});
