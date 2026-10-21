import type { RepoEntry } from '../../core/repo-context.js';
import { usageHistory } from '../../core/claude-usage.js';
import { repoDataOf } from '../../metrics/index.js';
import { computeSubscription, type Subscription } from '../../metrics/subscription.js';
import { cuentasView } from './cuentas-claude.js';
import { listRuns } from './dashboard-data.js';

// GET /api/metricas/suscripcion[?cuenta=<cuenta>] (#234, admins only): each
// Claude account's use of its plan, computed by metrics/subscription.ts
// from the quota's history, ronin's runs and what Métricas read from GitHub.
// The accounts are those of Ajustes → Cuentas de Claude.

// Eight closed weeks plus the current one, and the runs of the issues and
// PRs that closed in the last 30 days.
const RUN_DAYS = 63;

export async function suscripcionView(entries: RepoEntry[], account: string | null, now = Date.now()): Promise<{ accounts: string[]; cuentas: Subscription[] } | null> {
  const all = (await cuentasView(entries)).cuentas;
  const shown = account ? all.filter((c) => c.account === account) : all;
  if (account && !shown.length) return null;
  const runs = await listRuns(RUN_DAYS, new Date(now));
  const cuentas = await Promise.all(shown.map(async (c) => computeSubscription({
    account: c.account,
    plan: c.plan,
    repos: c.repos,
    history: await usageHistory(c.account),
    runs: runs.filter((r) => r.account === c.account),
    repoData: await repoDataOf(c.repos, now),
    now,
  })));
  return { accounts: all.map((c) => c.account), cuentas };
}
