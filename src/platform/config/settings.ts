import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../logger.js';
import type { AccountPlanChoice } from '../claude/claude-plans.js';

// The settings that can be changed from the dashboard (#174) instead of .env.
// What wins: the dashboard's value, then .env, then the default. The
// dashboard's values live in <SETTINGS_DATA_DIR>/settings.json, written only
// by the server (domains/settings/settings.ts); every process applies them over
// config when it loads it (config.ts), so the tick, a webhook handler or a
// worker started after a change already has it, and the server applies them
// again after each one it saves.
//
// Each one names the config field it overrides (`path`, under config) and
// the env var it comes from. Secrets, paths and ports never go here: they
// stay in .env, and the dashboard only shows whether they're set.

type Base = { key: string; env: string; path: string[] };
export type SettingDef =
  // `scale`: what config keeps per unit shown (minutes shown, milliseconds kept).
  | (Base & { type: 'int'; default: number; min: number; max: number; scale?: number })
  | (Base & { type: 'bool'; default: boolean })
  | (Base & { type: 'enum'; default: string; options: string[] })
  | (Base & { type: 'text'; default: string; check: (value: string) => string | null });

export type SettingValue = number | boolean | string;

export const MODELS = ['opus', 'sonnet', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return null;
  } catch {
    return 'Esa zona horaria no existe (p. ej. America/Tegucigalpa).';
  }
};
const validWindow = (value: string) => (/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value) ? null : 'Tiene que ser HH:MM-HH:MM (p. ej. 01:00-06:00).');

const int = (key: string, env: string, path: string[], def: number, min: number, max: number, scale?: number): SettingDef => ({ key, env, path, type: 'int', default: def, min, max, ...(scale ? { scale } : {}) });
const MIN = 60_000;

export const SETTINGS: SettingDef[] = [
  // General
  int('dashboard.sessionDays', 'DASHBOARD_SESSION_DAYS', ['dashboard', 'sessionDays'], 7, 1, 90),
  int('dashboard.githubTtlSeconds', 'DASHBOARD_GITHUB_TTL_SECONDS', ['dashboard', 'githubTtlSeconds'], 60, 10, 3600),
  int('portal.dailyLimit', 'PORTAL_DAILY_LIMIT', ['portal', 'dailyLimit'], 5, 0, 100),
  int('portal.sessionDays', 'PORTAL_SESSION_DAYS', ['portal', 'sessionDays'], 30, 1, 365),
  // Agentes ('' = whatever the account's Claude config says, as in .env)
  { key: 'agent.model', env: 'AGENT_MODEL', path: ['agentModel'], type: 'enum', default: 'opus', options: [...MODELS, ''] },
  { key: 'agent.effort', env: 'AGENT_EFFORT', path: ['agentEffort'], type: 'enum', default: 'high', options: [...EFFORTS, ''] },
  { key: 'agent.reviewWorkerModel', env: 'EXTERNAL_REVIEW_WORKER_MODEL', path: ['externalReviewWorkerModel'], type: 'enum', default: 'sonnet', options: MODELS },
  int('agent.taskTimeoutMinutes', 'AGENT_TASK_TIMEOUT_MINUTES', ['agentTaskTimeoutMs'], 30, 5, 240, MIN),
  int('agent.handlerTimeoutMinutes', 'EVENT_HANDLER_TIMEOUT_MINUTES', ['eventHandlerTimeoutMs'], 120, 10, 720, MIN),
  int('tick.intervalMinutes', 'TICK_INTERVAL_MINUTES', ['tickIntervalMinutes'], 30, 5, 240),
  int('tick.concurrency', 'TICK_CONCURRENCY', ['tickConcurrency'], 3, 1, 10),
  int('tick.externalReviewConcurrency', 'EXTERNAL_REVIEW_CONCURRENCY', ['externalReviewConcurrency'], 2, 0, 10),
  int('retry.e2e', 'E2E_RETRY_LIMIT', ['e2eRetryLimit'], 2, 0, 10),
  int('retry.e2eHard', 'E2E_ATTEMPT_HARD_LIMIT', ['e2eAttemptHardLimit'], 5, 1, 20),
  int('retry.checksPending', 'CHECKS_PENDING_RETRY_LIMIT', ['checksPendingRetryLimit'], 60, 1, 500),
  int('retry.slice', 'SLICE_ATTEMPT_LIMIT', ['sliceAttemptLimit'], 3, 1, 10),
  int('retry.retarget', 'RETARGET_RETRY_LIMIT', ['retargetRetryLimit'], 3, 1, 10),
  int('retry.issueError', 'ISSUE_ERROR_RETRY_LIMIT', ['issueErrorRetryLimit'], 3, 1, 10),
  // Exploración
  { key: 'explore.timezone', env: 'EXPLORE_TIMEZONE', path: ['exploreTimezone'], type: 'text', default: 'America/Tegucigalpa', check: validTimezone },
  { key: 'explore.nightWindow', env: 'EXPLORE_NIGHT_WINDOW', path: ['exploreNightWindow'], type: 'text', default: '01:00-06:00', check: validWindow },
  int('explore.functionsPerNight', 'EXPLORE_FUNCTIONS_PER_NIGHT', ['exploreFunctionsPerNight'], 3, 0, 20),
  int('explore.functionsPerRun', 'EXPLORE_FUNCTIONS_PER_RUN', ['exploreFunctionsPerRun'], 3, 1, 20),
  int('explore.findingsPerRun', 'EXPLORE_FINDINGS_PER_RUN', ['exploreFindingsPerRun'], 8, 0, 50),
  int('explore.ideasPerRun', 'EXPLORE_IDEAS_PER_RUN', ['exploreIdeasPerRun'], 2, 0, 20),
  { key: 'explore.publishEvidence', env: 'EXPLORE_PUBLISH_EVIDENCE', path: ['explorePublishEvidence'], type: 'bool', default: true },
  // Previews
  { key: 'preview.prepareData', env: 'PREVIEW_PREPARE_DATA', path: ['previewPrepareData'], type: 'bool', default: true },
  int('preview.ttlMinutes', 'PREVIEW_TTL_MINUTES', ['previewTtlMinutes'], 60, 0, 1440),
  int('preview.maxPerRepo', 'PREVIEW_MAX_PER_REPO', ['previewMaxPerRepo'], 2, 1, 10),
];

export const settingDef = (key: string) => SETTINGS.find((s) => s.key === key);

// The task types a run can be (agent-task.ts's `type`), for their own model
// and effort: AGENT_MODEL_<TIPO> / AGENT_EFFORT_<TIPO> in .env, or here.
export const TASK_TYPES = [
  'plan', 'implement-slice', 'fix-issue', 'fix-review', 'fix-e2e', 'review-request', 'fix-comments', 'fix-comments-external',
  'resolve-conflicts', 'thread-reply-external', 'external-review', 'internal-review', 'fix-internal-review', 'spike', 'write-spec', 'revise-spec', 'issue-request', 'prototype',
  'update-changelog', 'explore-inventory', 'explore-function', 'explore-evaluate', 'explore-redo-after', 'explore-feedback',
  'commit-subject', 'prepare-preview-data', 'preview-seed-catalog', 'preview-data-triage', 'preview-data-delta', 'portal-request', 'portal-interview', 'portal-prototype', 'portal-reproduce', 'meeting-read',
];

export interface SettingsFile {
  values: Record<string, SettingValue>;
  // Per task type, its own model and effort.
  tasks?: Record<string, { model?: string; effort?: string }>;
  // Per Claude account, the plan it pays (claude-plans.ts).
  accounts?: Record<string, AccountPlanChoice>;
}

export const settingsPath = (dataDir: string) => join(dataDir, 'settings.json');

// Why a value can't be saved, or null if it can.
export function invalidValue(def: SettingDef, value: unknown): string | null {
  switch (def.type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'Tiene que ser un número entero.';
      return value < def.min || value > def.max ? `Tiene que estar entre ${def.min} y ${def.max}.` : null;
    case 'bool':
      return typeof value === 'boolean' ? null : 'Tiene que ser sí o no.';
    case 'enum':
      return typeof value === 'string' && def.options.includes(value) ? null : `Tiene que ser uno de: ${def.options.map((o) => o || '(el de Claude)').join(', ')}.`;
    case 'text':
      return typeof value !== 'string' || !value.trim() ? 'No puede quedar vacío.' : def.check(value.trim());
  }
}

// What .env says, or undefined when it doesn't say anything usable. An empty
// AGENT_MODEL is a value ("whatever Claude says"); an empty number isn't.
export function envValue(def: SettingDef, env: NodeJS.ProcessEnv = process.env): SettingValue | undefined {
  const raw = env[def.env];
  if (raw === undefined) return undefined;
  switch (def.type) {
    case 'int': {
      if (raw.trim() === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'bool':
      return raw === 'false' ? false : raw === 'true' ? true : undefined;
    case 'enum':
      return raw;
    case 'text':
      return raw.trim() ? raw : undefined;
  }
}

// The dashboard's values, read synchronously: config.ts loads at import. A
// missing file is "nothing changed"; one that doesn't read, or a value out
// of range (the file edited by hand), is left out with a warning instead of
// stopping every process — .env still applies.
export function readSettingsSync(dataDir: string): SettingsFile {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error(`ajustes: no se pudo leer ${settingsPath(dataDir)}: ${(error as Error).message}`);
    return { values: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SettingsFile>;
    return {
      values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {},
      ...(parsed.tasks && typeof parsed.tasks === 'object' ? { tasks: parsed.tasks } : {}),
      ...(parsed.accounts && typeof parsed.accounts === 'object' ? { accounts: parsed.accounts } : {}),
    };
  } catch (error) {
    log.error(`ajustes: ${settingsPath(dataDir)} no es JSON válido, uso los de .env: ${(error as Error).message}`);
    return { values: {} };
  }
}

const saved = (def: SettingDef, file: SettingsFile) => {
  const value = file.values[def.key];
  return value !== undefined && invalidValue(def, value) === null ? value : undefined;
};

// What the setting is worth, in the units shown, and where that comes from.
function resolve(def: SettingDef, file: SettingsFile, env: NodeJS.ProcessEnv) {
  const fromEnv = envValue(def, env);
  const base = fromEnv ?? def.default;
  const mine = saved(def, file);
  return { value: mine ?? base, source: mine !== undefined ? 'tablero' as const : fromEnv !== undefined ? 'env' as const : 'defecto' as const, base, baseSource: fromEnv !== undefined ? 'env' as const : 'defecto' as const };
}

// Puts each setting's value in place over `target` (config): the
// dashboard's, or else .env's, or else the default. Applying it again after
// a value was reset brings back .env's.
export function applySettings(target: Record<string, unknown>, file: SettingsFile, env: NodeJS.ProcessEnv = process.env): void {
  for (const def of SETTINGS) {
    const holder = def.path.slice(0, -1).reduce<Record<string, unknown> | undefined>((at, part) => at?.[part] as Record<string, unknown> | undefined, target);
    if (!holder) continue;
    if (file.values[def.key] !== undefined && saved(def, file) === undefined) log.error(`ajustes: ${def.key}=${JSON.stringify(file.values[def.key])} no es válido, uso el de .env`);
    const { value } = resolve(def, file, env);
    holder[def.path[def.path.length - 1]] = def.type === 'int' && def.scale ? (value as number) * def.scale : def.type === 'text' ? (value as string).trim() : value;
  }
  // Per task type: read by agentModelFor / agentEffortFor (config.ts).
  const tasks: Record<string, { model?: string; effort?: string }> = {};
  for (const [task, choice] of Object.entries(file.tasks ?? {})) {
    if (!TASK_TYPES.includes(task) || !choice || typeof choice !== 'object') continue;
    const model = typeof choice.model === 'string' && MODELS.includes(choice.model) ? choice.model : undefined;
    const effort = typeof choice.effort === 'string' && EFFORTS.includes(choice.effort) ? choice.effort : undefined;
    if (model || effort) tasks[task] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  target.taskOverrides = tasks;
}

export type SettingSource = 'tablero' | 'env' | 'defecto';

export interface SettingView {
  key: string;
  env: string;
  type: SettingDef['type'];
  value: SettingValue;
  source: SettingSource;
  // What it'd be without the dashboard's value: .env's, or the default.
  base: SettingValue;
  baseSource: Exclude<SettingSource, 'tablero'>;
  min?: number;
  max?: number;
  options?: string[];
}

export function settingsView(file: SettingsFile, env: NodeJS.ProcessEnv = process.env): SettingView[] {
  return SETTINGS.map((def) => ({
    key: def.key,
    env: def.env,
    type: def.type,
    ...resolve(def, file, env),
    ...(def.type === 'int' ? { min: def.min, max: def.max } : {}),
    ...(def.type === 'enum' ? { options: def.options } : {}),
  }));
}
