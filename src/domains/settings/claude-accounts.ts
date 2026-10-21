import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import type { RepoEntry } from '../../platform/agents/repo-context.js';
import { accountName, listUsage, type AccountUsage } from '../../platform/claude/claude-usage.js';
import { accountPlan, PLANS, planOf, PRICE_MAX_USD, validPrice, type AccountPlan } from '../../platform/claude/claude-plans.js';
import { readSettings, updateSettings } from '../../platform/config/settings-store.js';
import { AjustesError, record } from './settings.js';

// Ajustes → Cuentas de Claude (#234, stage 1), admins only:
//   GET  /api/ajustes/cuentas            each account, with its repos, its plan and its usage now
//   POST /api/ajustes/cuentas/<cuenta>   { plan?, priceUsd? }: plan null goes back to the default (Max 5×)
//
// The accounts are the claudeConfigDir of each repo in repos.json, plus any
// with usage on record (an account a repo stopped using still has its
// history). The plan is saved with the rest of Ajustes (platform/config/settings-store.ts).

export interface CuentaView {
  account: string;
  // '' when the repos use Claude Code's default (~/.claude).
  claudeConfigDir: string;
  repos: string[];
  plan: AccountPlan;
  usage: Pick<AccountUsage, 'measuredAt' | 'fiveHour' | 'sevenDay' | 'limitHitAt'> | null;
}

const money = (usd: number | null) => (usd === null ? 'sin precio' : `$${usd}`);

export async function cuentasView(entries: RepoEntry[], given?: AccountUsage[]): Promise<{ plans: typeof PLANS; cuentas: CuentaView[] }> {
  const usage = given ?? await listUsage();
  const file = await readSettings(config.settings.dataDir);
  const byAccount = new Map<string, CuentaView>();
  const add = (claudeConfigDir: string) => {
    const account = accountName(claudeConfigDir);
    let view = byAccount.get(account);
    if (!view) {
      view = { account, claudeConfigDir, repos: [], plan: accountPlan(file, account), usage: null };
      byAccount.set(account, view);
    }
    return view;
  };
  for (const entry of entries) add(entry.claudeConfigDir ?? '').repos.push(entry.productRepo);
  for (const u of usage) {
    const { measuredAt, fiveHour, sevenDay, limitHitAt } = u;
    add(u.claudeConfigDir).usage = { measuredAt, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), ...(limitHitAt ? { limitHitAt } : {}) };
  }
  // The ones repos use first, then the rest; each by name.
  const cuentas = [...byAccount.values()].sort((a, b) => Number(!a.repos.length) - Number(!b.repos.length) || a.account.localeCompare(b.account));
  return { plans: PLANS, cuentas };
}

// POST /api/ajustes/cuentas/<cuenta>. Changing the plan takes its list
// price, unless a price comes with it; a plan without one keeps the price
// there was.
export async function setCuenta(login: string, account: string, body: Record<string, unknown>, entries: RepoEntry[]): Promise<unknown> {
  const before = (await cuentasView(entries)).cuentas.find((c) => c.account === account);
  if (!before) throw new AjustesError('Esa cuenta de Claude no está en repos.json ni tiene uso registrado.', { status: 404 });
  if (body.plan !== undefined && body.plan !== null && !planOf(String(body.plan))) throw new AjustesError(`El plan tiene que ser uno de: ${PLANS.map((p) => p.name).join(', ')}.`);
  if (body.priceUsd !== undefined && body.priceUsd !== null && !validPrice(body.priceUsd)) throw new AjustesError(`El precio tiene que ser un número entre 0 y ${PRICE_MAX_USD}.`);
  if (body.plan === undefined && body.priceUsd === undefined) throw new AjustesError('Falta el plan o el precio.');

  await updateSettings(config.settings.dataDir, login, (file) => {
    const accounts = { ...(file.accounts ?? {}) };
    if (body.plan === null) delete accounts[account];
    else {
      const plan = planOf(body.plan === undefined ? before.plan.plan : String(body.plan))!;
      const price = typeof body.priceUsd === 'number' ? body.priceUsd
        : body.priceUsd === null || (body.plan !== undefined && plan.priceUsd !== null) ? plan.priceUsd
          : before.plan.priceUsd;
      accounts[account] = { plan: plan.id, ...(price !== null && price !== plan.priceUsd ? { priceUsd: price } : {}) };
    }
    file.values ??= {};
    file.accounts = accounts;
  });

  const after = (await cuentasView(entries)).cuentas.find((c) => c.account === account)!;
  const shown = (p: AccountPlan) => `${p.name}${p.source === 'defecto' ? ' (por defecto)' : ''}`;
  if (before.plan.plan !== after.plan.plan || before.plan.source !== after.plan.source) await record({ login, what: `Cuentas de Claude · ${account} · plan`, from: shown(before.plan), to: shown(after.plan) });
  if (before.plan.priceUsd !== after.plan.priceUsd) await record({ login, what: `Cuentas de Claude · ${account} · precio al mes`, from: money(before.plan.priceUsd), to: money(after.plan.priceUsd) });
  if (before.plan.plan !== after.plan.plan || before.plan.priceUsd !== after.plan.priceUsd) log.info(`ajustes: ${login} puso la cuenta ${account} en ${after.plan.name} (${money(after.plan.priceUsd)})`);
  return { cuenta: after };
}
