import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ronin-cuentas-'));
const config = vi.hoisted(() => ({ settings: { dataDir: '' } }));
config.settings.dataDir = dir;
vi.mock('@platform/config/config.js', () => ({ config, taskEnvModel: () => undefined, taskEnvEffort: () => undefined, taskDefaultModel: () => undefined, taskDefaultEffort: () => undefined }));
vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const usage = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@platform/claude/claude-usage.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('@platform/claude/claude-usage.js')>()), listUsage: async () => usage.list }));

const { readSettingsLog } = await import('./settings.js');
const { accountsView, resetApiBudget, setAccountPlan } = await import('./claude-accounts.js');
const { addApiSpend } = await import('@platform/claude/api-fallback.js');

const ENTRIES = [
  { productRepo: 'redmotos/shoppingcart', productRepoPath: '/sc', claudeConfigDir: '/home/x/.claude-redmotos' },
  { productRepo: 'redmotos/backoffice', productRepoPath: '/bo', claudeConfigDir: '/home/x/.claude-redmotos' },
  { productRepo: 'Bmedical/bmedical', productRepoPath: '/bm', claudeConfigDir: '/home/x/.claude-bmedical' },
];
const set = (account: string, body: Record<string, unknown>) => setAccountPlan('jefa', account, body, ENTRIES);
const plan = async (account: string) => (await accountsView(ENTRIES)).cuentas.find((c) => c.account === account)!.plan;
const saved = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  usage.list = [];
});

describe('accountsView', () => {
  it('lists each account of repos.json with its repos, plus the ones with usage only, and counts an unset one as Max 5×', async () => {
    usage.list = [
      { account: 'redmotos', claudeConfigDir: '/home/x/.claude-redmotos', measuredAt: '2026-10-20T10:00:00Z', sevenDay: { utilization: 0.4, resetsAt: '2026-10-23T00:00:00Z' } },
      { account: 'vieja', claudeConfigDir: '/home/x/.claude-vieja', measuredAt: '2026-10-01T10:00:00Z' },
    ];
    const { cuentas, plans } = await accountsView(ENTRIES);
    expect(cuentas.map((c) => [c.account, c.repos])).toEqual([['bmedical', ['Bmedical/bmedical']], ['redmotos', ['redmotos/shoppingcart', 'redmotos/backoffice']], ['vieja', []]]);
    expect(cuentas[1]).toMatchObject({ claudeConfigDir: '/home/x/.claude-redmotos', plan: { plan: 'max5', name: 'Max 5×', priceUsd: 100, source: 'defecto' }, usage: { sevenDay: { utilization: 0.4 } } });
    expect(cuentas[0].usage).toBeNull();
    expect(plans.map((p) => p.name)).toEqual(['Pro', 'Max 5×', 'Max 20×', 'Team', 'Enterprise', 'Otro']);
  });

  it('names a repo without claudeConfigDir after Claude Code\'s default account', async () => {
    expect((await accountsView([{ productRepo: 'a/b', productRepoPath: '/b' }])).cuentas).toEqual([expect.objectContaining({ account: 'default', claudeConfigDir: '', repos: ['a/b'] })]);
  });
});

describe('setAccountPlan', () => {
  it('saves a plan with its list price, and records the change', async () => {
    await set('bmedical', { plan: 'pro' });
    expect(await plan('bmedical')).toEqual({ plan: 'pro', name: 'Pro', priceUsd: 20, source: 'tablero' });
    expect(saved().accounts).toEqual({ bmedical: { plan: 'pro' } });
    expect((await readSettingsLog()).map((e) => `${e.what}: ${e.from} → ${e.to}`)).toEqual([
      'Cuentas de Claude · bmedical · precio al mes: $100 → $20',
      'Cuentas de Claude · bmedical · plan: Max 5× (por defecto) → Pro',
    ]);
  });

  it('keeps a price typed by hand, and a plan without a list price keeps the one there was', async () => {
    await set('redmotos', { priceUsd: 90 });
    expect(await plan('redmotos')).toMatchObject({ plan: 'max5', priceUsd: 90, source: 'tablero' });
    await set('redmotos', { plan: 'team' });
    expect(await plan('redmotos')).toMatchObject({ plan: 'team', name: 'Team', priceUsd: 90 });
    await set('redmotos', { plan: 'max20' });
    expect(await plan('redmotos')).toMatchObject({ plan: 'max20', priceUsd: 200 });
    expect(saved().accounts.redmotos).toEqual({ plan: 'max20' });
  });

  it('goes back to the default with plan null', async () => {
    await set('redmotos', { plan: 'pro' });
    await set('redmotos', { plan: null });
    expect(await plan('redmotos')).toMatchObject({ plan: 'max5', priceUsd: 100, source: 'defecto' });
    expect(saved().accounts).toEqual({});
  });

  it('doesn\'t touch the other settings in the file', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values: { 'tick.concurrency': 4 }, tasks: { plan: { model: 'sonnet' } } }));
    await set('bmedical', { plan: 'pro' });
    expect(saved()).toEqual({ values: { 'tick.concurrency': 4 }, tasks: { plan: { model: 'sonnet' } }, accounts: { bmedical: { plan: 'pro' } } });
  });

  it('refuses an unknown account, plan or price, and saves nothing', async () => {
    await expect(set('otra', { plan: 'pro' })).rejects.toMatchObject({ status: 404 });
    await expect(set('bmedical', { plan: 'gratis' })).rejects.toThrow(/Pro, Max 5×/);
    await expect(set('bmedical', { priceUsd: -1 })).rejects.toThrow(/entre 0/);
    await expect(set('bmedical', { priceUsd: '20' })).rejects.toThrow(/entre 0/);
    await expect(set('bmedical', {})).rejects.toThrow(/Falta/);
    expect(await readSettingsLog()).toEqual([]);
  });

  it('records nothing when nothing changed', async () => {
    await set('bmedical', { plan: 'pro' });
    await set('bmedical', { plan: 'pro' });
    expect(await readSettingsLog()).toHaveLength(2);
  });
});

describe('the API fallback of a repo (#421)', () => {
  const entries = [
    { productRepo: 'acme/app', productRepoPath: '/a', claudeConfigDir: '/home/x/.claude-acme', apiFallback: { apiKeyEnv: 'ANTHROPIC_API_KEY_ACME_TEST', model: 'sonnet', maxUsd: 20 } },
    { productRepo: 'acme/web', productRepoPath: '/w', claudeConfigDir: '/home/x/.claude-acme' },
  ];

  it('shows under its account what it spent, and whether its key is set', async () => {
    await addApiSpend('acme/app', 3.5);
    const [acme] = (await accountsView(entries)).cuentas;
    expect(acme.apiFallbacks).toEqual([{ repo: 'acme/app', model: 'sonnet', maxUsd: 20, spentUsd: 3.5, apiKeyEnv: 'ANTHROPIC_API_KEY_ACME_TEST', keySet: false }]);
  });

  it('resets it to zero, and records who did', async () => {
    await addApiSpend('acme/app', 18);
    const { fallback } = await resetApiBudget('jefa', 'acme/app', entries);
    expect(fallback).toMatchObject({ spentUsd: 0, resetBy: 'jefa' });
    expect((await readSettingsLog()).map((e) => `${e.what}: ${e.from} → ${e.to}`)).toEqual(['Cuentas de Claude · acme/app · gastado por API: $18.00 → $0.00']);
    await expect(resetApiBudget('jefa', 'acme/web', entries)).rejects.toThrow(/no tiene respaldo por API/);
  });
});
