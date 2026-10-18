import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

// The settings that can be changed from the dashboard (#174) instead of .env.
// What wins: the dashboard's value, then .env, then the default. The
// dashboard's values live in <SETTINGS_DATA_DIR>/settings.json, written only
// by the server (server/api/ajustes.ts); every process applies them over
// config when it loads it (config.ts), so the tick, a webhook handler or a
// worker started after a change already has it, and the server applies them
// again after each one it saves.
//
// Each one names the config field it overrides (`path`, under config) and
// the env var it comes from. Secrets, paths and ports never go here: they
// stay in .env, and the dashboard only shows whether they're set.

export interface SettingDef {
  key: string;
  env: string;
  path: [string, string];
  default: number;
  min: number;
  max: number;
}

export const SETTINGS: SettingDef[] = [
  { key: 'dashboard.sessionDays', env: 'DASHBOARD_SESSION_DAYS', path: ['dashboard', 'sessionDays'], default: 7, min: 1, max: 90 },
  { key: 'dashboard.githubTtlSeconds', env: 'DASHBOARD_GITHUB_TTL_SECONDS', path: ['dashboard', 'githubTtlSeconds'], default: 60, min: 10, max: 3600 },
  { key: 'portal.dailyLimit', env: 'PORTAL_DAILY_LIMIT', path: ['portal', 'dailyLimit'], default: 5, min: 0, max: 100 },
  { key: 'portal.sessionDays', env: 'PORTAL_SESSION_DAYS', path: ['portal', 'sessionDays'], default: 30, min: 1, max: 365 },
];

export const settingDef = (key: string) => SETTINGS.find((s) => s.key === key);

export interface SettingsFile {
  values: Record<string, number>;
}

export const settingsPath = (dataDir: string) => join(dataDir, 'settings.json');

export class SettingError extends Error {}

// Why a value can't be saved, or null if it can.
export function invalidValue(def: SettingDef, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Tiene que ser un número entero.';
  if (value < def.min || value > def.max) return `Tiene que estar entre ${def.min} y ${def.max}.`;
  return null;
}

// What .env says, or undefined when it doesn't say anything usable.
export function envValue(def: SettingDef, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[def.env];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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
    return { values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {} };
  } catch (error) {
    log.error(`ajustes: ${settingsPath(dataDir)} no es JSON válido, uso los de .env: ${(error as Error).message}`);
    return { values: {} };
  }
}

// Puts each setting's value in place over `target` (config): the
// dashboard's, or else .env's, or else the default. Applying it again after
// a value was reset brings back .env's.
export function applySettings(target: Record<string, unknown>, file: SettingsFile, env: NodeJS.ProcessEnv = process.env): void {
  for (const def of SETTINGS) {
    const [section, field] = def.path;
    const holder = target[section] as Record<string, unknown> | undefined;
    if (!holder) continue;
    const saved = file.values[def.key];
    const usable = saved !== undefined && invalidValue(def, saved) === null;
    if (saved !== undefined && !usable) log.error(`ajustes: ${def.key}=${JSON.stringify(saved)} no es válido, uso el de .env`);
    holder[field] = usable ? saved : envValue(def, env) ?? def.default;
  }
}

export type SettingSource = 'tablero' | 'env' | 'defecto';

export interface SettingView {
  key: string;
  env: string;
  value: number;
  source: SettingSource;
  // What it'd be without the dashboard's value: .env's, or the default.
  base: number;
  baseSource: Exclude<SettingSource, 'tablero'>;
  min: number;
  max: number;
}

export function settingsView(file: SettingsFile, env: NodeJS.ProcessEnv = process.env): SettingView[] {
  return SETTINGS.map((def) => {
    const fromEnv = envValue(def, env);
    const base = fromEnv ?? def.default;
    const baseSource = fromEnv !== undefined ? 'env' as const : 'defecto' as const;
    const saved = file.values[def.key];
    const usable = saved !== undefined && invalidValue(def, saved) === null;
    return { key: def.key, env: def.env, value: usable ? saved : base, source: usable ? 'tablero' : baseSource, base, baseSource, min: def.min, max: def.max };
  });
}
