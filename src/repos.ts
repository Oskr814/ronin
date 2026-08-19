import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import type { RepoEntry } from './repo-context.js';

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
  const { productRepo, productRepoPath, claudeConfigDir } = entry as Record<string, unknown>;
  if (typeof productRepo !== 'string' || productRepo.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepo falta o no es un string`);
  }
  if (typeof productRepoPath !== 'string' || productRepoPath.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepoPath falta o no es un string`);
  }
  if (claudeConfigDir !== undefined && typeof claudeConfigDir !== 'string') {
    throw new Error(`${config.reposConfigPath}[${index}].claudeConfigDir debe ser un string si está presente`);
  }
  return { productRepo, productRepoPath, claudeConfigDir };
}
