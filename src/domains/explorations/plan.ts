import { CHARTERS, VIEWPORTS, type Charter, type DiscoveredFunction, type Inventory, type InventoryFunction } from './memory.js';
import { host } from '@platform/host/host.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { config } from '@platform/config/config.js';
import { isAgentCheckout } from '../product-app/index.js';


// What one exploration run tests: at most N functions, each with a charter
// drawn for it and both viewports — see docs/DESIGN.md §11.4. Pure apart from
// the git helpers at the bottom, and deterministic for a given seed: the seed
// goes into the run file and every finding, so a run can be replayed.

export interface PlannedFunction {
  functionId: string;
  charter: Charter;
  role: string;
  reason: 'nueva' | 'cambiada' | 'prioritaria' | 'antigua' | 'azar';
}

export interface ExplorationPlan {
  seed: number;
  functions: PlannedFunction[];
}

// mulberry32: tiny, fast and good enough to draw a handful of choices; what
// matters here is that the same seed always draws the same plan.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function weightedPick<T>(items: T[], weight: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let target = random() * total;
  for (const item of items) {
    target -= weight(item);
    if (target < 0) return item;
  }
  return items[items.length - 1];
}

function lastExplored(f: InventoryFunction): string | undefined {
  const dates = VIEWPORTS.flatMap((v) => Object.values(f.cobertura[v]));
  return dates.length > 0 ? dates.sort().at(-1) : undefined;
}

// Prefers a charter never applied to this function in any viewport; once
// every one has been, the one applied longest ago — so over time each
// function gets every angle (the function × charter matrix of §11.4).
export function pickCharter(f: InventoryFunction, random: () => number): Charter {
  const lastUse = (charter: Charter) =>
    VIEWPORTS.map((v) => f.cobertura[v][charter]).filter((d): d is string => !!d).sort().at(-1);
  const unused = CHARTERS.filter((c) => !lastUse(c));
  if (unused.length > 0) return unused[Math.floor(random() * unused.length)];
  return [...CHARTERS].sort((a, b) => lastUse(a)!.localeCompare(lastUse(b)!))[0];
}

export interface PlanInput {
  inventory: Inventory;
  // Functions whose files changed since they were last explored.
  changed: Set<string>;
  // Function → recent fix commits on its files; the random slot leans on it.
  risk: Record<string, number>;
  // Roles the manifest can log in as; a function is explored as one of its
  // own roles that is also here.
  roles: string[];
  maxFunctions: number;
  seed: number;
}

export function planRun(input: PlanInput): ExplorationPlan {
  const random = seededRandom(input.seed);
  const candidates = input.inventory.funciones.filter((f) => !f.retirada && f.prioridad !== 'excluida');

  // Shuffled first so that ties inside a tier go a different way each run.
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const tierOf = (f: InventoryFunction): PlannedFunction['reason'] =>
    !lastExplored(f) ? 'nueva' : input.changed.has(f.id) ? 'cambiada' : f.prioridad === 'alta' ? 'prioritaria' : 'antigua';
  const tierRank = { nueva: 0, cambiada: 1, prioritaria: 2, antigua: 3, azar: 4 };
  const ordered = shuffled
    .map((f, index) => ({ f, tier: tierOf(f), index }))
    .sort((a, b) =>
      tierRank[a.tier] - tierRank[b.tier] ||
      (a.tier === 'antigua' ? (lastExplored(a.f) ?? '').localeCompare(lastExplored(b.f) ?? '') : 0) ||
      a.index - b.index,
    );

  // One slot is random (weighted by risk) whenever there are at least two:
  // it finds what the ordered rotation would take months to reach.
  const max = Math.min(input.maxFunctions, ordered.length);
  const byPriority = ordered.slice(0, max >= 2 ? max - 1 : max);
  const chosen: Array<{ f: InventoryFunction; reason: PlannedFunction['reason'] }> = byPriority.map(({ f, tier }) => ({ f, reason: tier }));
  const rest = ordered.slice(byPriority.length).map(({ f }) => f);
  if (max >= 2 && rest.length > 0) {
    chosen.push({ f: weightedPick(rest, (f) => 1 + (input.risk[f.id] ?? 0), random), reason: 'azar' });
  }

  return {
    seed: input.seed,
    functions: chosen.map(({ f, reason }) => {
      const roles = f.roles.filter((r) => input.roles.includes(r));
      const pool = roles.length > 0 ? roles : input.roles;
      return { functionId: f.id, charter: pickCharter(f, random), role: pool[Math.floor(random() * pool.length)], reason };
    }),
  };
}

// The agent's functions.json (see prompts.ts's explore-inventory),
// validated: an entry without an id, a name or a route is dropped, and ids
// are normalized to "<module>.<function>" in lowercase.
export function parseDiscoveredFunctions(raw: string): { functions: DiscoveredFunction[]; dropped: string[] } {
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.functions) ? (parsed as any).functions : null;
  if (!list) throw new Error('functions.json no contiene una lista de funciones');
  const functions: DiscoveredFunction[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-') : '';
    const name = typeof entry?.nombre === 'string' ? entry.nombre.trim() : '';
    const rutas = strings(entry?.rutas);
    if (!id || !name || rutas.length === 0) {
      dropped.push(`entrada inválida: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    if (seen.has(id)) {
      dropped.push(`id repetido: ${id}`);
      continue;
    }
    seen.add(id);
    functions.push({ id, nombre: name, rutas, roles: strings(entry.roles), archivos: strings(entry.archivos) });
  }
  return { functions, dropped };
}

// Where ronin reads the history of the code an exploration runs on: the
// shared repo at the base branch when the checkout is the agent's clone
// (#257: ronin runs no git of its own there), the checkout itself otherwise.
export async function codeHistory(codeDir: string): Promise<{ dir: string; rev: string }> {
  return (await isAgentCheckout(codeDir))
    ? { dir: activeRepo().productRepoPath, rev: activeRepo().worktreeBaseRef ?? config.worktreeBaseRef }
    : { dir: codeDir, rev: 'HEAD' };
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await host().exec('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// The last commit that touched the app — the inventory is refreshed only
// when this moves past inventory.actualizado.sha.
// `rev`: the commit the app's code is at (run.ts's codeHistory).
export async function lastCommitTouching(dir: string, path: string, rev = 'HEAD'): Promise<string> {
  return git(dir, ['log', '-1', '--format=%H', rev, '--', path]);
}

export async function changedFunctions(dir: string, inventory: Inventory, rev = 'HEAD'): Promise<Set<string>> {
  const changed = new Set<string>();
  for (const f of inventory.funciones) {
    const since = lastExplored(f);
    if (!since || f.archivos.length === 0) continue;
    const out = await git(dir, ['log', '-1', '--format=%H', `--since=${since}T23:59:59`, rev, '--', ...f.archivos]).catch(() => '');
    if (out) changed.add(f.id);
  }
  return changed;
}

// Commits whose subject says "fix" on each function's files in the last 90
// days: a cheap proxy for where bugs keep turning up.
export async function riskByFunction(dir: string, inventory: Inventory, rev = 'HEAD'): Promise<Record<string, number>> {
  const risk: Record<string, number> = {};
  for (const f of inventory.funciones) {
    if (f.archivos.length === 0) continue;
    const out = await git(dir, ['log', '--since=90 days ago', '--format=%s', '-i', '--grep=fix', rev, '--', ...f.archivos]).catch(() => '');
    risk[f.id] = out ? out.split('\n').length : 0;
  }
  return risk;
}
