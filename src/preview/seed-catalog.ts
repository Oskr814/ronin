import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { activeRepo } from '../core/repo-context.js';
import { config } from '../core/config.js';
import type { AppDefinition, AppStep } from '../app/index.js';

const execFileAsync = promisify(execFile);

// What an app has right after its base seed (#202): per entity, how many
// records, the cases they cover and how to find them in the app. An agent
// writes it once per hash of what defines that data — the seed files, the
// migrations and the manifest's `run` steps — and every later preview with
// the same hash reads it instead of exploring the database again. It lives
// in ronin's data dir, per repo, app and hash; a change to the seeds is a
// new hash, so a new catalog. See docs/DESIGN.md §12.

// Without `seedPaths` in the manifest: every tracked file under a seeds,
// migrations, dumps or fixtures directory, or whose name says seed. Too
// much only costs an extra catalog now and then; too little would keep a
// stale one.
const CONVENTION_RE = /(^|\/)(seeds?|migrations?|dumps?|fixtures?)\/|(^|\/)[^/]*seed[^/]*$/i;

export interface TreeEntry {
  path: string;
  blob: string;
}

// `git ls-tree -r` lines ("<mode> <type> <object>\t<path>") → the files
// that define the base data.
export function seedEntries(lsTree: string, seedPaths?: string[]): TreeEntry[] {
  const prefixes = seedPaths?.map((p) => p.replace(/^\.?\/+|\/+$/g, ''));
  const wanted = (path: string) => prefixes
    ? prefixes.some((p) => path === p || path.startsWith(`${p}/`))
    : CONVENTION_RE.test(path);
  return lsTree.split('\n').flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return [];
    const path = line.slice(tab + 1);
    const [, type, blob] = line.slice(0, tab).split(' ');
    return type === 'blob' && wanted(path) ? [{ path, blob }] : [];
  });
}

export function seedHash(entries: TreeEntry[], steps: AppStep[]): string {
  const hash = createHash('sha256');
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${e.blob} ${e.path}\n`);
  for (const step of steps) {
    if ('run' in step) hash.update(`${JSON.stringify({ run: step.run, cwd: step.cwd ?? null, env: step.env ?? null })}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

function repoSlug(): string {
  return activeRepo().productRepo.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Where the catalog of `app` at commit `sha` of the active repo lives.
export async function seedCatalogPath(dir: string, sha: string, appName: string, app: Pick<AppDefinition, 'steps' | 'seedPaths'>): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--full-tree', sha], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  const hash = seedHash(seedEntries(stdout, app.seedPaths), app.steps);
  return join(config.seedCatalogs.dataDir, repoSlug(), appName, `${hash}.yaml`);
}

export async function readSeedCatalog(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

const MAX_CATALOG_BYTES = 64 * 1024;

// What the agent wrote, if it's a catalog worth keeping: YAML with
// something in it, and short enough to hand every later prompt.
export function parseSeedCatalog(raw: string): string {
  const text = raw.trim();
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error(`el catálogo pesa más de ${MAX_CATALOG_BYTES / 1024} KB`);
  const parsed: unknown = parseYaml(text);
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) throw new Error('el catálogo está vacío o no es un YAML con entidades');
  return text;
}

// Written whole or not at all: two previews with the same hash may write
// it at once, and a reader never sees half of one.
export async function saveSeedCatalog(path: string, text: string, header: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${header.split('\n').map((l) => `# ${l}`).join('\n')}\n${text}\n`);
  await rename(tmp, path);
}
