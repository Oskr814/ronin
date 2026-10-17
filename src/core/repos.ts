import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import type { RepoEntry, AgentDefaults } from './repo-context.js';

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
  const { productRepo, productRepoPath, claudeConfigDir, worktreeBaseRef, changelogRepo, changelogRepoPath, explore, agent, linear } = entry as Record<string, unknown>;
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
  return {
    productRepo, productRepoPath, claudeConfigDir, worktreeBaseRef, changelogRepo, changelogRepoPath,
    ...(explore !== undefined ? { explore: explore as string[] } : {}),
    ...(agent !== undefined ? { agent: validateAgent(agent, `${config.reposConfigPath}[${index}].agent`) } : {}),
    ...(linear !== undefined ? { linear: validateLinear(linear, `${config.reposConfigPath}[${index}].linear`) } : {}),
  };
}

function validateLinear(linear: unknown, where: string): { apiKeyEnv: string } {
  if (typeof linear !== 'object' || linear === null || Array.isArray(linear)) throw new Error(`${where} debe ser un objeto`);
  const { apiKeyEnv, ...rest } = linear as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) throw new Error(`${where} tiene campos desconocidos: ${unknownKeys.join(', ')} (válidos: apiKeyEnv)`);
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${where}.apiKeyEnv debe ser el nombre de una variable de .env (p. ej. LINEAR_API_KEY_REDMOTOS)`);
  return { apiKeyEnv };
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
