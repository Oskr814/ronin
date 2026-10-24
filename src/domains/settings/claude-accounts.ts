import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import type { RepoEntry } from '@platform/agents/repo-context.js';
import { accountName, listUsage, type AccountUsage } from '@platform/claude/claude-usage.js';
import { accountPlan, PLANS, planOf, PRICE_MAX_USD, validPrice, type AccountPlan } from '@platform/claude/claude-plans.js';
import { readSettings, updateSettings } from '@platform/config/settings-store.js';
import { apiFallbackView, resetApiSpend, type ApiFallbackView } from '@platform/claude/api-fallback.js';
import { SettingsError, record } from './settings.js';

// Ajustes → Cuentas de Claude (#234, stage 1), admins only:
//   GET  /api/settings/accounts            each account, with its repos, its plan and its usage now
//   POST /api/settings/accounts/<cuenta>   { plan?, priceUsd? }: plan null goes back to the default (Max 5×)
//   POST /api/settings/api-budget/<owner>/<repo>/reset   sets what the repo spent by API back to zero (#421)
//
// The accounts are the claudeConfigDir of each repo in repos.json, plus any
// with usage on record (an account a repo stopped using still has its
// history). The plan is saved with the rest of Ajustes (platform/config/settings-store.ts).

export interface AccountView {
  account: string;
  // '' when the repos use Claude Code's default (~/.claude).
  claudeConfigDir: string;
  repos: string[];
  plan: AccountPlan;
  usage: Pick<AccountUsage, 'measuredAt' | 'fiveHour' | 'sevenDay' | 'limitHitAt'> | null;
  // The repos of the account with an API fallback (#421): what each spent
  // of its cap since it was last reset, and whether its key is in .env.
  apiFallbacks: ApiFallbackView[];
}

const money = (usd: number | null) => (usd === null ? 'sin precio' : `$${usd}`);

export async function accountsView(entries: RepoEntry[], given?: AccountUsage[]): Promise<{ plans: typeof PLANS; cuentas: AccountView[] }> {
  const usage = given ?? await listUsage();
  const file = await readSettings(config.settings.dataDir);
  const byAccount = new Map<string, AccountView>();
  const add = (claudeConfigDir: string) => {
    const account = accountName(claudeConfigDir);
    let view = byAccount.get(account);
    if (!view) {
      view = { account, claudeConfigDir, repos: [], plan: accountPlan(file, account), usage: null, apiFallbacks: [] };
      byAccount.set(account, view);
    }
    return view;
  };
  for (const entry of entries) {
    const view = add(entry.claudeConfigDir ?? '');
    view.repos.push(entry.productRepo);
    const fallback = await apiFallbackView(entry);
    if (fallback) view.apiFallbacks.push(fallback);
  }
  for (const u of usage) {
    const { measuredAt, fiveHour, sevenDay, limitHitAt } = u;
    add(u.claudeConfigDir).usage = { measuredAt, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), ...(limitHitAt ? { limitHitAt } : {}) };
  }
  // The ones repos use first, then the rest; each by name.
  const accounts = [...byAccount.values()].sort((a, b) => Number(!a.repos.length) - Number(!b.repos.length) || a.account.localeCompare(b.account));
  return { plans: PLANS, cuentas: accounts };
}

// POST /api/settings/accounts/<cuenta>. Changing the plan takes its list
// price, unless a price comes with it; a plan without one keeps the price
// there was.
export async function setAccountPlan(login: string, account: string, body: Record<string, unknown>, entries: RepoEntry[]): Promise<unknown> {
  const before = (await accountsView(entries)).cuentas.find((c) => c.account === account);
  if (!before) throw new SettingsError('Esa cuenta de Claude no está en repos.json ni tiene uso registrado.', { status: 404 });
  if (body.plan !== undefined && body.plan !== null && !planOf(String(body.plan))) throw new SettingsError(`El plan tiene que ser uno de: ${PLANS.map((p) => p.name).join(', ')}.`);
  if (body.priceUsd !== undefined && body.priceUsd !== null && !validPrice(body.priceUsd)) throw new SettingsError(`El precio tiene que ser un número entre 0 y ${PRICE_MAX_USD}.`);
  if (body.plan === undefined && body.priceUsd === undefined) throw new SettingsError('Falta el plan o el precio.');

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

  const after = (await accountsView(entries)).cuentas.find((c) => c.account === account)!;
  const shown = (p: AccountPlan) => `${p.name}${p.source === 'defecto' ? ' (por defecto)' : ''}`;
  if (before.plan.plan !== after.plan.plan || before.plan.source !== after.plan.source) await record({ login, what: `Cuentas de Claude · ${account} · plan`, from: shown(before.plan), to: shown(after.plan) });
  if (before.plan.priceUsd !== after.plan.priceUsd) await record({ login, what: `Cuentas de Claude · ${account} · precio al mes`, from: money(before.plan.priceUsd), to: money(after.plan.priceUsd) });
  if (before.plan.plan !== after.plan.plan || before.plan.priceUsd !== after.plan.priceUsd) log.info(`ajustes: ${login} puso la cuenta ${account} en ${after.plan.name} (${money(after.plan.priceUsd)})`);
  return { cuenta: after };
}

// POST /api/settings/api-budget/<owner>/<repo>/reset: after topping up the
// key's credits, what the repo spent by API counts from zero again.
export async function resetApiBudget(login: string, repo: string, entries: RepoEntry[]): Promise<{ fallback: ApiFallbackView }> {
  const entry = entries.find((e) => e.productRepo === repo);
  const before = entry ? await apiFallbackView(entry) : null;
  if (!entry || !before) throw new SettingsError('Ese repo no tiene respaldo por API en repos.json.', { status: 404 });
  await resetApiSpend(repo, login);
  await record({ login, what: `Cuentas de Claude · ${repo} · gastado por API`, from: `$${before.spentUsd.toFixed(2)}`, to: '$0.00' });
  log.info(`ajustes: ${login} reinició lo gastado por API de ${repo} ($${before.spentUsd.toFixed(2)})`);
  return { fallback: (await apiFallbackView(entry))! };
}
