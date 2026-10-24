import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import type { RepoEntry, AgentDefaults, ApiFallbackConfig, DeployConfig, PortalRepoConfig } from '../agents/repo-context.js';
import { MODELS } from './settings.js';

// The same top as TICK_CONCURRENCY's in Ajustes (platform/config/settings.ts).
export const MAX_REPO_CONCURRENCY = 10;

export async function loadRepos(): Promise<RepoEntry[]> {
  let raw: string;
  try {
    raw = await readFile(config.reposConfigPath, 'utf8');
  } catch {
    throw new Error(`No se pudo leer ${config.reposConfigPath} — ver REPOS_CONFIG_PATH en .env.example y repos.json.example`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${config.reposConfigPath} no es JSON válido: ${(error as Error).message}`);
  }

  return validateRepos(parsed);
}

// The same checks loadRepos makes, for a list about to be written (the
// dashboard's Ajustes → Repos, #174): what doesn't pass is never saved.
export function validateRepos(parsed: unknown): RepoEntry[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${config.reposConfigPath} debe ser un array con al menos un repo`);
  }

  const entries = parsed.map((entry, i) => validateEntry(entry, i));

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.productRepo)) {
      throw new Error(
        `${config.reposConfigPath} tiene el repo "${entry.productRepo}" duplicado — cada productRepo debe aparecer una sola vez`,
      );
    }
    seen.add(entry.productRepo);
  }

  return entries;
}

function validateEntry(entry: unknown, index: number): RepoEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${config.reposConfigPath}[${index}] no es un objeto`);
  }
  const { productRepo, productRepoPath, claudeConfigDir, worktreeBaseRef, changelogRepo, changelogRepoPath, explore, agent, linear, portal, deploy, autoMerge, concurrency, apiFallback } = entry as Record<string, unknown>;
  if (typeof productRepo !== 'string' || productRepo.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepo falta o no es un string`);
  }
  if (typeof productRepoPath !== 'string' || productRepoPath.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepoPath falta o no es un string`);
  }
  if (claudeConfigDir !== undefined && typeof claudeConfigDir !== 'string') {
    throw new Error(`${config.reposConfigPath}[${index}].claudeConfigDir debe ser un string si está presente`);
  }
  if (worktreeBaseRef !== undefined && typeof worktreeBaseRef !== 'string') {
    throw new Error(`${config.reposConfigPath}[${index}].worktreeBaseRef debe ser un string si está presente`);
  }
  if (changelogRepo !== undefined && (typeof changelogRepo !== 'string' || changelogRepo.length === 0)) {
    throw new Error(`${config.reposConfigPath}[${index}].changelogRepo debe ser un string si está presente`);
  }
  if (changelogRepoPath !== undefined && (typeof changelogRepoPath !== 'string' || changelogRepoPath.length === 0)) {
    throw new Error(`${config.reposConfigPath}[${index}].changelogRepoPath debe ser un string si está presente`);
  }
  if ((changelogRepo === undefined) !== (changelogRepoPath === undefined)) {
    throw new Error(`${config.reposConfigPath}[${index}]: changelogRepo y changelogRepoPath van juntos — falta uno de los dos`);
  }
  if (explore !== undefined && (!Array.isArray(explore) || explore.some((a) => typeof a !== 'string' || a.length === 0))) {
    throw new Error(`${config.reposConfigPath}[${index}].explore debe ser una lista de nombres de apps (de ronin.app.json)`);
  }
  if (autoMerge !== undefined && typeof autoMerge !== 'boolean') {
    throw new Error(`${config.reposConfigPath}[${index}].autoMerge debe ser true o false si está presente`);
  }
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_REPO_CONCURRENCY)) {
    throw new Error(`${config.reposConfigPath}[${index}].concurrency debe ser un entero entre 1 y ${MAX_REPO_CONCURRENCY} si está presente`);
  }
  return {
    productRepo, productRepoPath, claudeConfigDir, worktreeBaseRef, changelogRepo, changelogRepoPath,
    ...(explore !== undefined ? { explore: explore as string[] } : {}),
    ...(agent !== undefined ? { agent: validateAgent(agent, `${config.reposConfigPath}[${index}].agent`) } : {}),
    ...(linear !== undefined ? { linear: validateLinear(linear, `${config.reposConfigPath}[${index}].linear`) } : {}),
    ...(portal !== undefined ? { portal: validatePortal(portal, `${config.reposConfigPath}[${index}].portal`) } : {}),
    ...(deploy !== undefined ? { deploy: validateDeploy(deploy, `${config.reposConfigPath}[${index}].deploy`) } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
    ...(concurrency !== undefined ? { concurrency: concurrency as number } : {}),
    ...(apiFallback !== undefined ? { apiFallback: validateApiFallback(apiFallback, `${config.reposConfigPath}[${index}].apiFallback`) } : {}),
  };
}

function validateDeploy(deploy: unknown, where: string): DeployConfig {
  if (typeof deploy !== 'object' || deploy === null || Array.isArray(deploy)) throw new Error(`${where} debe ser un objeto ({} si no usa pre-releases ni PRs elegidos)`);
  const { prerelease, selective, auto, ...rest } = deploy as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: prerelease, selective, auto)`);
  if (prerelease !== undefined && typeof prerelease !== 'boolean') throw new Error(`${where}.prerelease debe ser true o false`);
  if (selective !== undefined && typeof selective !== 'boolean') throw new Error(`${where}.selective debe ser true o false`);
  if (auto !== undefined && (typeof auto !== 'object' || auto === null || typeof (auto as { tag?: unknown }).tag !== 'string' || Object.keys(auto).some((k) => k !== 'tag'))) {
    throw new Error(`${where}.auto debe ser { "tag": "<patrón>" }, por ejemplo { "tag": "v{major}.{minor}.{patch+1}" }`);
  }
  return { ...(prerelease !== undefined ? { prerelease } : {}), ...(selective !== undefined ? { selective } : {}), ...(auto !== undefined ? { auto: { tag: (auto as { tag: string }).tag } } : {}) };
}

function validatePortal(portal: unknown, where: string): PortalRepoConfig {
  if (typeof portal !== 'object' || portal === null || Array.isArray(portal)) throw new Error(`${where} debe ser un objeto`);
  const { name, apps, notifyTo, ...rest } = portal as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: name, apps, notifyTo)`);
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${where}.name debe ser el nombre con el que el portal muestra el repo (p. ej. "Red Motos")`);
  if (typeof apps !== 'object' || apps === null || Array.isArray(apps) || Object.keys(apps).length === 0) {
    throw new Error(`${where}.apps debe ser un objeto app de ronin.app.json → { name, description? }`);
  }
  for (const [app, value] of Object.entries(apps)) {
    const { name: appName, description, ...extra } = (value ?? {}) as Record<string, unknown>;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof appName !== 'string' || !appName.trim()
      || (description !== undefined && typeof description !== 'string') || Object.keys(extra).length > 0) {
      throw new Error(`${where}.apps.${app} debe ser { name, description? }`);
    }
  }
  if (notifyTo !== undefined && (!Array.isArray(notifyTo) || notifyTo.length === 0 || notifyTo.some((a) => typeof a !== 'string' || !/^[^\s@,]+@[^\s@,]+$/.test(a)))) {
    throw new Error(`${where}.notifyTo debe ser una lista de correos (p. ej. ["ana@x.com", "luis@x.com"])`);
  }
  return { name, apps: apps as PortalRepoConfig['apps'], ...(notifyTo !== undefined ? { notifyTo: notifyTo as string[] } : {}) };
}

function validateLinear(linear: unknown, where: string): NonNullable<RepoEntry['linear']> {
  if (typeof linear !== 'object' || linear === null || Array.isArray(linear)) throw new Error(`${where} debe ser un objeto`);
  const { apiKeyEnv, explorationProject, ...rest } = linear as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: apiKeyEnv, explorationProject)`);
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${where}.apiKeyEnv debe ser el nombre de una variable de .env (p. ej. LINEAR_API_KEY_REDMOTOS)`);
  if (explorationProject !== undefined && (!isStringMap(explorationProject) || Object.values(explorationProject).some((v) => !v.trim()))) {
    throw new Error(`${where}.explorationProject debe ser un objeto app → proyecto de Linear (nombre o id)`);
  }
  return { apiKeyEnv, ...(explorationProject !== undefined ? { explorationProject: explorationProject as Record<string, string> } : {}) };
}

export const API_FALLBACK_MAX_USD = 10_000;

// The model defaults to sonnet: cheaper than the runs' usual one, and
// enough to finish what a run had going (#421).
function validateApiFallback(fallback: unknown, where: string): ApiFallbackConfig {
  if (typeof fallback !== 'object' || fallback === null || Array.isArray(fallback)) throw new Error(`${where} debe ser un objeto`);
  const { apiKeyEnv, model, maxUsd, ...rest } = fallback as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: apiKeyEnv, model, maxUsd)`);
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${where}.apiKeyEnv debe ser el nombre de una variable de .env (p. ej. ANTHROPIC_API_KEY_REDMOTOS)`);
  if (apiKeyEnv === 'ANTHROPIC_API_KEY') throw new Error(`${where}.apiKeyEnv no puede ser ANTHROPIC_API_KEY: en el entorno de ronin, todas las corridas cobrarían a la API`);
  if (model !== undefined && (typeof model !== 'string' || !MODELS.includes(model))) throw new Error(`${where}.model debe ser uno de: ${MODELS.join(', ')}`);
  if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > API_FALLBACK_MAX_USD) throw new Error(`${where}.maxUsd debe ser el tope de gasto en USD, un número mayor que 0 y hasta ${API_FALLBACK_MAX_USD}`);
  return { apiKeyEnv, model: (model as string | undefined) ?? 'sonnet', maxUsd };
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');

// An empty string is allowed everywhere, like in the env vars: "whatever the
// Claude config of this account says".
function validateAgent(agent: unknown, where: string): AgentDefaults {
  if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) throw new Error(`${where} debe ser un objeto`);
  const { model, effort, models, efforts, reviewWorkerModel, ...rest } = agent as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: model, effort, models, efforts, reviewWorkerModel)`);
  for (const [name, value] of Object.entries({ model, effort, reviewWorkerModel })) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`${where}.${name} debe ser un string si está presente`);
  }
  for (const [name, value] of Object.entries({ models, efforts })) {
    if (value !== undefined && !isStringMap(value)) throw new Error(`${where}.${name} debe ser un objeto de tipo de tarea → string`);
  }
  return agent as AgentDefaults;
}
