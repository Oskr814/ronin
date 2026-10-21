import { describe, it, expect, vi } from 'vitest';

const PLAN = { plan: 'max5', name: 'Max 5×', priceUsd: 100, source: 'defecto' };
vi.mock('../settings/claude-accounts.js', () => ({ cuentasView: () => ({ cuentas: [{ account: 'redmotos', repos: ['redmotos/shoppingcart'], plan: PLAN }, { account: 'bmedical', repos: ['Bmedical/bmedical'], plan: { ...PLAN, plan: 'pro', priceUsd: 20 } }] }) }));
const runs = [
  { account: 'redmotos', repo: 'redmotos/shoppingcart', taskType: 'fix-issue', startedAt: '2026-10-19T10:00:00Z', endedAt: '2026-10-19T11:00:00Z', costUsd: 3 },
  { account: 'bmedical', repo: 'Bmedical/bmedical', taskType: 'plan', startedAt: '2026-10-19T10:00:00Z', endedAt: '2026-10-19T11:00:00Z', costUsd: 1 },
];
vi.mock('../runs/data.js', () => ({ listRuns: () => runs }));
const readUsageHistory = vi.fn((_account: string) => []);
vi.mock('../../core/claude-usage.js', () => ({ usageHistory: async (a: string) => readUsageHistory(a) }));
const repoDataOf = vi.fn(async (_repos: string[]) => []);
vi.mock('./index.js', () => ({ repoDataOf: (r: string[]) => repoDataOf(r) }));

const { suscripcionView } = await import('./subscription-view.js');
const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('suscripcionView', () => {
  it('computes every account with its own history, runs, plan and repos', async () => {
    const out = (await suscripcionView([], null, NOW))!;
    expect(out.accounts).toEqual(['redmotos', 'bmedical']);
    expect(out.cuentas.map((c) => [c.account, c.value.equivUsd, c.value.ratio])).toEqual([['redmotos', 3, 0.03], ['bmedical', 1, 0.05]]);
    expect(readUsageHistory.mock.calls.map((c) => c[0])).toEqual(['redmotos', 'bmedical']);
    expect(repoDataOf).toHaveBeenCalledWith(['Bmedical/bmedical']);
  });

  it('computes only the one asked for, and nothing for an account that isn\'t there', async () => {
    expect((await suscripcionView([], 'bmedical', NOW))!.cuentas.map((c) => c.account)).toEqual(['bmedical']);
    expect(await suscripcionView([], 'otra', NOW)).toBeNull();
  });
});
