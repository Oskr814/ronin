import { join } from 'node:path';
import { sql } from 'kysely';
import { config } from '../config/config.js';
import { onStore } from '../store/backend.js';
import { readJson, withJson } from '../fs/atomic-json.js';
import type { ApiFallbackConfig, RepoEntry } from '../agents/repo-context.js';

// The API fallback (#421): a repo with `apiFallback` in repos.json finishes
// on its Anthropic Console API key the run the subscription's quota cut
// halfway (agents/agent-task.ts), on a cheaper model, up to `maxUsd`.
//
// What it spent is a counter per repo, added to as each run on the key ends
// and set back to zero from Ajustes when the credits are topped up. ronin
// only reads its own runs' total_cost_usd: a run killed before its result
// (a timeout) adds nothing, and two running at once each get what was left
// when they started. The hard cap is the key's workspace spend limit in the
// Console, which the docs ask for.
//
// With DATABASE_URL, in api_budgets; else in <SETTINGS_DATA_DIR>/api-budget.json.

export interface ApiBudget {
  spentUsd: number;
  resetAt?: string;
  resetBy?: string;
}

type BudgetFile = Record<string, ApiBudget>;

// Less than this left and a cut run waits for the quota instead: claude -p
// checks --max-budget-usd only after each turn, so a run can go one turn
// past it, and a turn on a long context costs about this much.
export const MIN_LEFT_USD = 0.5;

const budgetPath = () => join(config.settings.dataDir, 'api-budget.json');
const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

export function readApiBudget(repo: string): Promise<ApiBudget> {
  return onStore({
    db: async (db) => {
      const row = await db.selectFrom('api_budgets').select(['spent_usd', 'reset_at', 'reset_by']).where('repo', '=', repo).executeTakeFirst();
      if (!row) return { spentUsd: 0 };
      return { spentUsd: row.spent_usd, ...(row.reset_at ? { resetAt: row.reset_at.toISOString() } : {}), ...(row.reset_by ? { resetBy: row.reset_by } : {}) };
    },
    files: async () => (await readJson<BudgetFile>(budgetPath(), () => ({})))[repo] ?? { spentUsd: 0 },
  });
}

export function addApiSpend(repo: string, usd: number): Promise<void> {
  if (!(usd > 0)) return Promise.resolve();
  return onStore({
    db: async (db) => {
      await db.insertInto('api_budgets').values({ repo, spent_usd: usd })
        .onConflict((oc) => oc.column('repo').doUpdateSet({ spent_usd: sql<number>`api_budgets.spent_usd + ${usd}`, updated_at: sql<string>`now()` }))
        .execute();
    },
    files: () => withJson<BudgetFile, void>(budgetPath(), () => ({}), (file) => {
      file[repo] = { ...(file[repo] ?? {}), spentUsd: round((file[repo]?.spentUsd ?? 0) + usd) };
    }),
  });
}

export function resetApiSpend(repo: string, by: string, now = new Date()): Promise<void> {
  const resetAt = now.toISOString();
  return onStore({
    db: async (db) => {
      const row = { spent_usd: 0, reset_at: resetAt, reset_by: by, updated_at: resetAt };
      await db.insertInto('api_budgets').values({ repo, ...row }).onConflict((oc) => oc.column('repo').doUpdateSet(row)).execute();
    },
    files: () => withJson<BudgetFile, void>(budgetPath(), () => ({}), (file) => {
      file[repo] = { spentUsd: 0, resetAt, resetBy: by };
    }),
  });
}

// What a cut run of this repo needs to go on by API: the key, the model and
// how much it may spend. null when the repo has no fallback, its key isn't
// in .env, or what's left is under MIN_LEFT_USD.
export async function apiFallbackFor(repo: Pick<RepoEntry, 'productRepo' | 'apiFallback'>, env: NodeJS.ProcessEnv = process.env): Promise<{ apiKey: string; model: string; leftUsd: number } | null> {
  const fallback: ApiFallbackConfig | undefined = repo.apiFallback;
  if (!fallback) return null;
  const apiKey = env[fallback.apiKeyEnv];
  if (!apiKey) return null;
  const leftUsd = round(fallback.maxUsd - (await readApiBudget(repo.productRepo)).spentUsd);
  return leftUsd >= MIN_LEFT_USD ? { apiKey, model: fallback.model, leftUsd } : null;
}

// What Ajustes shows of a repo's fallback (domains/settings/claude-accounts.ts).
export interface ApiFallbackView {
  repo: string;
  model: string;
  maxUsd: number;
  spentUsd: number;
  resetAt?: string;
  resetBy?: string;
  apiKeyEnv: string;
  keySet: boolean;
}

export async function apiFallbackView(entry: RepoEntry): Promise<ApiFallbackView | null> {
  const fallback = entry.apiFallback;
  if (!fallback) return null;
  return { repo: entry.productRepo, model: fallback.model, maxUsd: fallback.maxUsd, ...(await readApiBudget(entry.productRepo)), apiKeyEnv: fallback.apiKeyEnv, keySet: Boolean(process.env[fallback.apiKeyEnv]) };
}

// For the status bar: the repos past 80% of their cap, or with too little left to go on.
export const API_BUDGET_WARN = 0.8;
export async function apiBudgetsToWarn(entries: RepoEntry[]): Promise<Array<{ repo: string; spentUsd: number; maxUsd: number; out: boolean }>> {
  const views = await Promise.all(entries.map(apiFallbackView));
  return views.filter((v): v is ApiFallbackView => v !== null && v.spentUsd >= v.maxUsd * API_BUDGET_WARN)
    .map((v) => ({ repo: v.repo, spentUsd: v.spentUsd, maxUsd: v.maxUsd, out: v.maxUsd - v.spentUsd < MIN_LEFT_USD }));
}
