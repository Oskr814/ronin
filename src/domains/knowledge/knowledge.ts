import { join } from 'node:path';
import { activeRepo } from '@platform/agents/repo-context.js';
import { config } from '@platform/config/config.js';
import { readJson, withJson } from '@platform/fs/atomic-json.js';
import { host } from '@platform/host/host.js';
import { log } from '@platform/logger.js';

// What the agents learned about an app (#412), kept for the next run: its
// screens (route → components → endpoints → entities, and how to reach each
// one on the running app, with the script of captures that worked, #411),
// the traps that cost time, and the requests already merged. One file per
// repo and app in ronin's data dir: never in this repo nor the product's.
// It describes the code and the app, never people: no request's text, no
// client's data. See docs/DESIGN.md §16.16.

export interface Reach {
  role?: string;
  viewport?: 'desktop' | 'mobile';
  steps?: string;
  // One capture of bin/ronin-shots.mjs's script that reached it (#411).
  script?: unknown;
}

interface Entry {
  // S1, S2… for screens, T1… for traps: what the agents name them by.
  id: string;
  // What it's based on: when one of these changed since `commit`, it's to
  // be checked before trusting it.
  files: string[];
  commit: string;
  updatedAt: string;
  usedAt: string;
}

export interface Screen extends Entry {
  route: string;
  name: string;
  components: string[];
  endpoints: string[];
  entities: string[];
  reach?: Reach;
}

export interface Trap extends Entry {
  text: string;
}

// A request whose PR merged: what it was about and what it touched, from
// its diff, without an agent.
export interface Resolved {
  request: number;
  summary: string;
  files: string[];
  pr?: number;
  mergedAt: string;
}

export interface Knowledge {
  screens: Screen[];
  traps: Trap[];
  resolved: Resolved[];
}

// What an agent left in its JSON, already parsed (parseLearned).
export interface Learned {
  used: string[];
  screens: Array<Omit<Screen, 'id' | 'commit' | 'updatedAt' | 'usedAt'> & { id?: string; capture?: number }>;
  traps: Array<{ id?: string; text: string; files: string[] }>;
  removed: string[];
}

// Who reads and writes it: the portal's runs, on by default, or a PR's
// preview (#437), on per app — repos.json's `knowledge`.
export type KnowledgeUse = 'portal' | 'previews';

export function knowledgeOn(appName: string, use: KnowledgeUse): boolean {
  const k = activeRepo().knowledge;
  return use === 'portal' ? !(k?.portalOff ?? []).includes(appName) : (k?.previews ?? []).includes(appName);
}

const UNUSED_DAYS = 30;
export const LIMITS = { screens: 80, traps: 40, resolved: 50 };
const MAX_INDEX = 4_000;
const empty = (): Knowledge => ({ screens: [], traps: [], resolved: [] });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function knowledgePath(appName: string, repo = activeRepo().productRepo): string {
  return join(config.knowledge.dataDir, slug(repo), slug(appName) || 'app', 'bitacora.json');
}

export function readKnowledge(appName: string): Promise<Knowledge> {
  return readJson(knowledgePath(appName), empty).catch((error) => {
    log.error(`bitácora: no se pudo leer la de ${appName}; sigue sin ella`, error);
    return empty();
  });
}

// The base branch's commit, the one the checkouts of a request come from:
// what an entry written now is based on.
export async function baseCommit(): Promise<string> {
  const repo = activeRepo();
  const { stdout } = await host().exec('git', ['rev-parse', repo.worktreeBaseRef ?? config.worktreeBaseRef], { cwd: repo.productRepoPath });
  return stdout.trim();
}

// Entries unused for a month go, and each list keeps its most recently
// used up to its limit.
export function prune(k: Knowledge, now = new Date()): void {
  const cutoff = now.getTime() - UNUSED_DAYS * 24 * 3600_000;
  const keep = <T extends Entry>(list: T[], max: number) => list
    .filter((e) => Date.parse(e.usedAt) >= cutoff)
    .sort((a, b) => b.usedAt.localeCompare(a.usedAt))
    .slice(0, max);
  k.screens = keep(k.screens, LIMITS.screens);
  k.traps = keep(k.traps, LIMITS.traps);
  k.resolved = [...k.resolved].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, LIMITS.resolved);
}

// The ids of the entries whose files changed between their commit and the
// base branch, or whose commit the repo no longer has: one git call per
// commit.
export async function staleIds(k: Knowledge, ref?: string): Promise<Set<string>> {
  const repo = activeRepo();
  const head = ref ?? repo.worktreeBaseRef ?? config.worktreeBaseRef;
  const byCommit = new Map<string, Entry[]>();
  for (const e of [...k.screens, ...k.traps]) byCommit.set(e.commit, [...(byCommit.get(e.commit) ?? []), e]);
  const stale = new Set<string>();
  for (const [commit, entries] of byCommit) {
    const files = [...new Set(entries.flatMap((e) => e.files))];
    if (!files.length) continue;
    try {
      const { stdout } = await host().exec('git', ['diff', '--name-only', commit, head, '--', ...files.map((f) => `:(literal)${f}`)], { cwd: repo.productRepoPath, maxBuffer: 4 * 1024 * 1024 });
      const changed = new Set(stdout.split('\n').filter(Boolean));
      for (const e of entries) if (e.files.some((f) => changed.has(f))) stale.add(e.id);
    } catch {
      for (const e of entries) stale.add(e.id);
    }
  }
  return stale;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// What goes in the prompt: a line per entry, a few KB at most. The detail
// is in the file the run gets (knowledgeFile).
export function knowledgeIndex(k: Knowledge, stale: Set<string>): string {
  const mark = (id: string) => (stale.has(id) ? ' (a verificar)' : '');
  const sections = [
    k.screens.length ? `Pantallas:\n${k.screens.map((s) => `- ${s.id} ${clip(s.name, 80)} — ${clip(s.route, 100)}${s.reach?.script ? ' [guion]' : ''}${mark(s.id)}`).join('\n')}` : '',
    k.traps.length ? `Trampas:\n${k.traps.map((t) => `- ${t.id} ${clip(t.text, 140)}${mark(t.id)}`).join('\n')}` : '',
    k.resolved.length ? `Pedidos resueltos:\n${k.resolved.map((r) => `- P-${r.request} ${clip(r.summary, 80)} — ${clip(r.files.slice(0, 4).join(', '), 120)}${r.files.length > 4 ? '…' : ''}`).join('\n')}` : '',
  ].filter(Boolean);
  return clip(sections.join('\n\n'), MAX_INDEX);
}

// The whole of it, for the run to open when it needs the detail, each
// entry saying whether to check it first.
export function knowledgeFile(k: Knowledge, stale: Set<string>): string {
  const flag = <T extends Entry>(e: T) => ({ ...e, ...(stale.has(e.id) ? { verificar: true } : {}) });
  return JSON.stringify({ screens: k.screens.map(flag), traps: k.traps.map(flag), resolved: k.resolved }, null, 2);
}

export interface KnowledgeForRun {
  index: string;
  // Where the run finds the detail, inside its own output dir.
  path?: string;
}

// What a run on `appName` gets: the index, and the detail written into
// `dir` (its output dir: a sealed run reads nothing of ronin's data, #257).
// Nothing when the app has none yet, or it can't be read.
export async function knowledgeForRun(appName: string, dir?: string, use: KnowledgeUse = 'portal'): Promise<KnowledgeForRun | undefined> {
  if (!knowledgeOn(appName, use)) return undefined;
  try {
    const k = await readKnowledge(appName);
    prune(k);
    if (!k.screens.length && !k.traps.length && !k.resolved.length) return undefined;
    const stale = await staleIds(k);
    if (!dir) return { index: knowledgeIndex(k, stale) };
    const path = join(dir, 'bitacora.json');
    await host().fs.writeFile(path, knowledgeFile(k, stale));
    return { index: knowledgeIndex(k, stale), path };
  } catch (error) {
    log.error(`bitácora: no se pudo preparar la de ${appName} para la corrida`, error);
    return undefined;
  }
}

const strings = (value: unknown, max: number, each = 300): string[] =>
  (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map((v) => clip(v.trim(), each)).slice(0, max);
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.trim() ? clip(value.trim(), max) : undefined);

// The agent's "bitacora": only what has a usable shape. Undefined when
// there's nothing in it.
export function parseLearned(value: unknown): Learned | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const screens: Learned['screens'] = [];
  for (const item of Array.isArray(v.pantallas) ? v.pantallas.slice(0, 10) : []) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    const route = text(s.ruta, 200);
    const name = text(s.nombre, 120);
    if (!route || !name) continue;
    const components = strings(s.componentes, 15);
    const reach = typeof s.llegar === 'object' && s.llegar !== null ? s.llegar as Record<string, unknown> : {};
    const steps = text(reach.pasos, 600);
    const role = text(reach.rol, 60);
    const viewport = reach.viewport === 'desktop' || reach.viewport === 'mobile' ? reach.viewport : undefined;
    screens.push({
      ...(text(s.id, 10) ? { id: text(s.id, 10) } : {}),
      route, name, components,
      endpoints: strings(s.endpoints, 15, 200),
      entities: strings(s.entidades, 15, 80),
      files: strings(s.archivos, 20).length ? strings(s.archivos, 20) : components,
      ...(steps || role || viewport ? { reach: { ...(role ? { role } : {}), ...(viewport ? { viewport } : {}), ...(steps ? { steps } : {}) } } : {}),
      ...(Number.isInteger(s.captura) ? { capture: s.captura as number } : {}),
    });
  }
  const traps: Learned['traps'] = [];
  for (const item of Array.isArray(v.trampas) ? v.trampas.slice(0, 10) : []) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const body = text(t.texto, 400);
    if (body) traps.push({ ...(text(t.id, 10) ? { id: text(t.id, 10) } : {}), text: body, files: strings(t.archivos, 20) });
  }
  const learned = { used: strings(v.usadas, 40, 10), screens, traps, removed: strings(v.borrar, 20, 10) };
  return learned.used.length || screens.length || traps.length || learned.removed.length ? learned : undefined;
}

// One capture of the run's script (bin/ronin-shots.mjs), by its number.
function captureOf(script: string | undefined, n: number | undefined): unknown {
  if (!script || n === undefined) return undefined;
  try {
    const captures = (JSON.parse(script) as { capturas?: unknown[] }).capturas;
    return captures?.find((c) => (c as { n?: unknown })?.n === n);
  } catch {
    return undefined;
  }
}

const nextId = (prefix: string, list: Entry[]) => `${prefix}${Math.max(0, ...list.map((e) => Number(e.id.slice(1)) || 0)) + 1}`;

// Folds what a run learned into the app's bitácora: a screen by its id or
// its route, a trap by its id, each written or confirmed now on `commit`;
// what it used is fresh again; what it found wrong goes.
export function mergeLearned(k: Knowledge, learned: Learned, commit: string, opts: { script?: string; now?: Date } = {}): void {
  const at = (opts.now ?? new Date()).toISOString();
  k.screens = k.screens.filter((s) => !learned.removed.includes(s.id));
  k.traps = k.traps.filter((t) => !learned.removed.includes(t.id));
  for (const e of [...k.screens, ...k.traps]) if (learned.used.includes(e.id)) e.usedAt = at;
  for (const { capture, id, ...screen } of learned.screens) {
    const existing = k.screens.find((s) => (id && s.id === id) || s.route.toLowerCase() === screen.route.toLowerCase());
    const script = captureOf(opts.script, capture) ?? existing?.reach?.script;
    const reach = screen.reach || script ? { ...existing?.reach, ...screen.reach, ...(script ? { script } : {}) } : existing?.reach;
    const next: Screen = { ...screen, id: existing?.id ?? nextId('S', k.screens), commit, updatedAt: at, usedAt: at, ...(reach ? { reach } : {}) };
    if (existing) Object.assign(existing, next);
    else k.screens.push(next);
  }
  for (const { id, ...trap } of learned.traps) {
    const existing = id ? k.traps.find((t) => t.id === id) : undefined;
    const next: Trap = { ...trap, id: existing?.id ?? nextId('T', k.traps), commit, updatedAt: at, usedAt: at };
    if (existing) Object.assign(existing, next);
    else k.traps.push(next);
  }
  prune(k, opts.now);
}

// Inside withActiveRepo, after a run that left a "bitacora": never fails
// the request it came with. `commit`: what the run's checkout was, when not
// the base branch — a preview's PR head (#437). What that PR changed then
// stays to check until the base branch has the same files (staleIds).
export async function saveLearned(appName: string, learned: Learned | undefined, opts: { script?: string; commit?: string; use?: KnowledgeUse } = {}): Promise<void> {
  if (!learned || !knowledgeOn(appName, opts.use ?? 'portal')) return;
  try {
    const commit = opts.commit ?? await baseCommit();
    await withJson(knowledgePath(appName), empty, (k) => mergeLearned(k, learned, commit, opts));
  } catch (error) {
    log.error(`bitácora: no se pudo guardar lo aprendido sobre ${appName}`, error);
  }
}

// A request whose PR merged (follow.ts): written by ronin, from the PR's
// files, no agent.
export async function saveResolved(appName: string, resolved: Resolved): Promise<void> {
  if (!knowledgeOn(appName, 'portal')) return;
  try {
    await withJson(knowledgePath(appName), empty, (k) => {
      k.resolved = [resolved, ...k.resolved.filter((r) => r.request !== resolved.request)];
      prune(k);
    });
  } catch (error) {
    log.error(`bitácora: no se pudo anotar el pedido P-${resolved.request} de ${appName}`, error);
  }
}
