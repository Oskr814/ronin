import type { SettingsFile } from './settings.js';

// The plan each Claude account pays (#234), for Métricas → Suscripción: what
// ronin's runs would have cost on the API against what the plan costs. Set
// from Ajustes → Cuentas de Claude, saved in settings.json under `accounts`,
// keyed by account name (claude-usage.ts's accountName). An account nobody
// set counts as Max 5×.
//
// Team, Enterprise and Otro have no list price: the price is whatever was
// typed.

export interface Plan {
  id: string;
  name: string;
  priceUsd: number | null;
}

export const PLANS: Plan[] = [
  { id: 'pro', name: 'Pro', priceUsd: 20 },
  { id: 'max5', name: 'Max 5×', priceUsd: 100 },
  { id: 'max20', name: 'Max 20×', priceUsd: 200 },
  { id: 'team', name: 'Team', priceUsd: null },
  { id: 'enterprise', name: 'Enterprise', priceUsd: null },
  { id: 'otro', name: 'Otro', priceUsd: null },
];

export const DEFAULT_PLAN = 'max5';
export const PRICE_MAX_USD = 100_000;

export const planOf = (id: string) => PLANS.find((p) => p.id === id);

// What's saved for an account: the plan, and the price only when it isn't
// the plan's list price.
export interface AccountPlanChoice {
  plan: string;
  priceUsd?: number;
}

export interface AccountPlan {
  plan: string;
  name: string;
  // Null only for a plan without a list price saved without one (by hand).
  priceUsd: number | null;
  source: 'tablero' | 'defecto';
}

export const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= PRICE_MAX_USD;

// An entry edited by hand into something that doesn't read counts as unset.
export function accountPlan(file: SettingsFile, account: string): AccountPlan {
  const saved = file.accounts?.[account];
  const plan = saved && typeof saved === 'object' ? planOf(saved.plan) : undefined;
  if (!plan) {
    const def = planOf(DEFAULT_PLAN)!;
    return { plan: def.id, name: def.name, priceUsd: def.priceUsd, source: 'defecto' };
  }
  return { plan: plan.id, name: plan.name, priceUsd: validPrice(saved!.priceUsd) ? saved!.priceUsd : plan.priceUsd, source: 'tablero' };
}
