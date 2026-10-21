import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

// Exploration's memory, kept in the product repo itself (docs/exploration/
// <app>/) so it's versioned and reviewed in the weekly PR like anything else
// — see docs/DESIGN.md §11.6:
//
//   inventory.yml  the index: every function of the app, its coverage and
//                  its findings — the one file read whole on every run
//   knowledge.md   what the team already decided ("ya cubierto", "descartado")
//   findings/      one file per finding or idea; only the frontmatter is
//                  read to decide (dedup by huella)
//   runs/          the plan and outcome of each run, for humans only
//
// One directory per app, since a repo can declare several in ronin.app.json.
// Keys are in Spanish: the team reads and edits these files by hand.

export const EXPLORATION_DIR = 'docs/exploration';

export const VIEWPORTS = ['desktop', 'mobile'] as const;
export type ViewportName = (typeof VIEWPORTS)[number];

export const CHARTERS = [
  'camino-feliz',
  'datos-hostiles',
  'interrupciones',
  'concurrencia',
  'volumen',
  'primera-vez',
  'recorrido-completo',
  'cambio-de-dispositivo',
] as const;
export type Charter = (typeof CHARTERS)[number];

export const SIGNALS = [
  'muchos-pasos',
  'ida-y-vuelta',
  'pantalla-cargada',
  'bug',
  'patron-global',
  'inconsistencia',
  'ui-muerta',
] as const;
export type Signal = (typeof SIGNALS)[number];

// Most severe first — the order findings are published and capped in.
export const SEVERITIES = ['bug', 'bloquea', 'lenta', 'inconsistencia', 'pulido'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATES = ['propuesto', 'aprobado', 'rechazado', 'resuelto'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export type Priority = 'normal' | 'alta' | 'excluida';

export interface InventoryFunction {
  id: string;
  nombre: string;
  rutas: string[];
  roles: string[];
  archivos: string[];
  // Written by the team; a refresh never overwrites these two.
  notas?: string;
  prioridad: Priority;
  // charter → last date it was explored with, per viewport.
  cobertura: Record<ViewportName, Partial<Record<Charter, string>>>;
  hallazgos: string[];
  // Date the function stopped showing up in the app; kept so its history
  // and findings aren't lost.
  retirada?: string;
}

export interface Inventory {
  // Last time the function list was refreshed from the app's code, and at
  // which commit — a refresh is skipped while the app's path hasn't changed.
  actualizado?: { fecha: string; sha: string };
  funciones: InventoryFunction[];
}

export interface FindingMeta {
  id: string;
  tipo: 'hallazgo' | 'idea';
  titulo: string;
  funcion: string;
  senal: Signal | 'idea';
  gravedad: Severity;
  charter: Charter;
  viewport: ViewportName;
  rol: string;
  semilla: number;
  fecha: string;
  estado: FindingState;
  huella: string;
  issue?: number;
  // A problem of the dev environment ronin ran (seed data, stubs), not of
  // the app: recorded and reviewed, but never an issue before the review.
  entorno?: boolean;
  motivo?: string;
  // Who decided its state in the review (the GitHub login of whoever
  // rejected, edited or approved it), and when.
  revisor?: string;
  revisado?: string;
}

export interface Finding extends FindingMeta {
  body: string;
}

export interface ExplorationMemory {
  dir: string;
  inventory: Inventory;
  findings: FindingMeta[];
  knowledge: string;
}

export function memoryDirFor(checkoutDir: string, appName: string): string {
  return join(checkoutDir, EXPLORATION_DIR, appName);
}

function emptyCoverage(): InventoryFunction['cobertura'] {
  return { desktop: {}, mobile: {} };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Tolerant on purpose: these files are edited by hand, and a typo in one
// function must not make the whole memory unreadable — an unknown priority
// falls back to normal, a malformed coverage entry is dropped.
export function parseInventory(raw: string): Inventory {
  const doc = (parse(raw) ?? {}) as Record<string, any>;
  const funciones = (Array.isArray(doc.funciones) ? doc.funciones : []).flatMap((f: any): InventoryFunction[] => {
    if (typeof f?.id !== 'string' || f.id.length === 0) return [];
    const cobertura = emptyCoverage();
    for (const viewport of VIEWPORTS) {
      for (const [charter, date] of Object.entries(f.cobertura?.[viewport] ?? {})) {
        if ((CHARTERS as readonly string[]).includes(charter) && typeof date === 'string') cobertura[viewport][charter as Charter] = date;
      }
    }
    return [{
      id: f.id,
      nombre: typeof f.nombre === 'string' ? f.nombre : f.id,
      rutas: asStringArray(f.rutas),
      roles: asStringArray(f.roles),
      archivos: asStringArray(f.archivos),
      ...(typeof f.notas === 'string' && f.notas.trim() ? { notas: f.notas.trim() } : {}),
      prioridad: f.prioridad === 'alta' || f.prioridad === 'excluida' ? f.prioridad : 'normal',
      cobertura,
      hallazgos: asStringArray(f.hallazgos),
      ...(typeof f.retirada === 'string' ? { retirada: f.retirada } : {}),
    }];
  });
  const actualizado = typeof doc.actualizado?.fecha === 'string' && typeof doc.actualizado?.sha === 'string'
    ? { fecha: doc.actualizado.fecha, sha: doc.actualizado.sha }
    : undefined;
  return { ...(actualizado ? { actualizado } : {}), funciones };
}

const INVENTORY_HEADER = [
  '# Inventario de funciones que ronin explora — ver docs/exploration/README.md.',
  '# El equipo puede editar `notas` y `prioridad` (normal | alta | excluida);',
  '# ronin mantiene el resto.',
  '',
].join('\n');

export function serializeInventory(inventory: Inventory): string {
  return INVENTORY_HEADER + stringify(inventory, { lineWidth: 0 });
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseFinding(raw: string): Finding {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error('la ficha no tiene frontmatter');
  const meta = (parse(match[1]) ?? {}) as Record<string, any>;
  for (const key of ['id', 'funcion', 'huella', 'estado'] as const) {
    if (typeof meta[key] !== 'string' || meta[key].length === 0) throw new Error(`la ficha no tiene "${key}"`);
  }
  // `señal` in the file (what a human writes), `senal` in code.
  const senal = meta['señal'] ?? meta.senal;
  return {
    id: meta.id,
    tipo: meta.tipo === 'idea' ? 'idea' : 'hallazgo',
    titulo: typeof meta.titulo === 'string' ? meta.titulo : meta.id,
    funcion: meta.funcion,
    senal,
    gravedad: meta.gravedad,
    charter: meta.charter,
    viewport: meta.viewport,
    rol: meta.rol,
    semilla: Number(meta.semilla),
    fecha: String(meta.fecha ?? ''),
    estado: (FINDING_STATES as readonly string[]).includes(meta.estado) ? meta.estado : 'propuesto',
    huella: meta.huella,
    ...(typeof meta.issue === 'number' ? { issue: meta.issue } : {}),
    ...(meta.entorno === true ? { entorno: true } : {}),
    ...(typeof meta.motivo === 'string' ? { motivo: meta.motivo } : {}),
    ...(typeof meta.revisor === 'string' && meta.revisor ? { revisor: meta.revisor } : {}),
    ...(typeof meta.revisado === 'string' && meta.revisado ? { revisado: meta.revisado } : {}),
    body: match[2].trim(),
  };
}

export function serializeFinding(finding: Finding): string {
  const { body, senal, ...rest } = finding;
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    meta[key] = value;
    if (key === 'tipo') meta['señal'] = senal;
  }
  return `---\n${stringify(meta, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function slugify(text: string, maxLength = 48): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/, '') || 'hallazgo';
}

export function findingFileName(finding: Pick<FindingMeta, 'id' | 'titulo'>): string {
  return `${finding.id}-${slugify(finding.titulo)}.md`;
}

export function nextFindingId(findings: Pick<FindingMeta, 'id'>[]): string {
  const max = findings.reduce((acc, f) => Math.max(acc, Number(f.id.replace(/^F-/, '')) || 0), 0);
  return `F-${String(max + 1).padStart(4, '0')}`;
}

// A huella is "<function>|<what fails>|<consequence>" in the agent's words.
// Normalizing (accents, case, punctuation) catches the same finding written
// slightly differently; the token overlap below catches the rest.
export function normalizeHuella(huella: string): string[] {
  return huella
    .split('|')
    .map((part) => slugify(part, 200))
    .filter(Boolean);
}

function tokens(huella: string): Set<string> {
  return new Set(normalizeHuella(huella).flatMap((part) => part.split('-')).filter((t) => t.length > 2));
}

export const HUELLA_SIMILARITY = 0.6;

// The finding (any state, rejected ones included — those are exactly what
// must not come back) this candidate repeats, if any: same normalized huella,
// or the same function and enough words in common.
export function findDuplicate(
  candidate: Pick<FindingMeta, 'funcion' | 'huella'>,
  existing: Pick<FindingMeta, 'id' | 'funcion' | 'huella'>[],
): string | undefined {
  const key = normalizeHuella(candidate.huella).join('|');
  const candidateTokens = tokens(candidate.huella);
  for (const finding of existing) {
    if (normalizeHuella(finding.huella).join('|') === key) return finding.id;
    if (finding.funcion !== candidate.funcion) continue;
    const other = tokens(finding.huella);
    const common = [...candidateTokens].filter((t) => other.has(t)).length;
    const union = new Set([...candidateTokens, ...other]).size;
    if (union > 0 && common / union >= HUELLA_SIMILARITY) return finding.id;
  }
  return undefined;
}

export interface DiscoveredFunction {
  id: string;
  nombre: string;
  rutas: string[];
  roles: string[];
  archivos: string[];
}

// Folds a fresh list of the app's functions (from reading its code) into
// the inventory: new ones are added, existing ones get their routes, roles
// and files updated (never the team's notas/prioridad, never the coverage),
// missing ones are marked retired and come back if they reappear.
export function mergeInventory(inventory: Inventory, discovered: DiscoveredFunction[], today: string, sha: string): {
  inventory: Inventory;
  added: string[];
  retired: string[];
} {
  const byId = new Map(discovered.map((f) => [f.id, f]));
  const added: string[] = [];
  const retired: string[] = [];
  const funciones = inventory.funciones.map((existing): InventoryFunction => {
    const fresh = byId.get(existing.id);
    if (!fresh) {
      if (!existing.retirada) retired.push(existing.id);
      return { ...existing, retirada: existing.retirada ?? today };
    }
    const { retirada: _, ...rest } = existing;
    return { ...rest, nombre: fresh.nombre, rutas: fresh.rutas, roles: fresh.roles, archivos: fresh.archivos };
  });
  for (const fresh of discovered) {
    if (inventory.funciones.some((f) => f.id === fresh.id)) continue;
    funciones.push({ ...fresh, prioridad: 'normal', cobertura: emptyCoverage(), hallazgos: [] });
    added.push(fresh.id);
  }
  return { inventory: { actualizado: { fecha: today, sha }, funciones }, added, retired };
}

export function recordCoverage(
  inventory: Inventory,
  functionId: string,
  entries: Array<{ viewport: ViewportName; charter: Charter }>,
  date: string,
  findingIds: string[],
): Inventory {
  return {
    ...inventory,
    funciones: inventory.funciones.map((f) => {
      if (f.id !== functionId) return f;
      const cobertura = { desktop: { ...f.cobertura.desktop }, mobile: { ...f.cobertura.mobile } };
      for (const { viewport, charter } of entries) cobertura[viewport][charter] = date;
      return { ...f, cobertura, hallazgos: [...new Set([...f.hallazgos, ...findingIds])] };
    }),
  };
}

const README = `# Exploración de ronin

ronin levanta esta app, la usa como cada rol en desktop y mobile, y propone
mejoras con evidencia. Este directorio es su memoria (ver el diseño en
Oskr814/ronin, docs/DESIGN.md §11):

- \`inventory.yml\`: las funciones de la app, qué charters se aplicaron a cada
  una y cuándo, y sus hallazgos. Podés editar \`notas\` (contexto que la app no
  muestra, p. ej. "bodega la usa desde el teléfono") y \`prioridad\`
  (\`normal\`, \`alta\` o \`excluida\`).
- \`knowledge.md\`: lo que el equipo ya decidió. ronin no vuelve a proponer
  nada de lo que está acá.
- \`findings/\`: una ficha por hallazgo o idea. Para rechazar una, comentá en
  el PR semanal sobre la ficha con el motivo.
- \`runs/\`: el plan y el resultado de cada corrida.
`;

const KNOWLEDGE_TEMPLATE = `# Conocimiento del equipo

Decisiones que ronin tiene que respetar al explorar: lo que ya está cubierto,
lo que se descartó y por qué. Una línea por decisión; ronin agrega acá los
rechazos del PR semanal.

`;

export async function loadMemory(dir: string): Promise<ExplorationMemory> {
  const inventory = await readFile(join(dir, 'inventory.yml'), 'utf8').then(parseInventory, () => ({ funciones: [] }));
  const knowledge = await readFile(join(dir, 'knowledge.md'), 'utf8').catch(() => '');
  const findings: FindingMeta[] = [];
  const files = await readdir(join(dir, 'findings')).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { body: _, ...meta } = parseFinding(await readFile(join(dir, 'findings', file), 'utf8'));
      findings.push(meta);
    } catch {
      // A hand-edited file that no longer parses doesn't take the rest down.
    }
  }
  return { dir, inventory, findings, knowledge };
}

// Creates the directory with its README and an empty knowledge.md the first
// time; never overwrites them afterwards.
export async function ensureMemoryDir(dir: string): Promise<void> {
  await mkdir(join(dir, 'findings'), { recursive: true });
  await mkdir(join(dir, 'runs'), { recursive: true });
  await writeFile(join(dir, 'README.md'), README, { flag: 'wx' }).catch(() => {});
  await writeFile(join(dir, 'knowledge.md'), KNOWLEDGE_TEMPLATE, { flag: 'wx' }).catch(() => {});
}

export async function saveInventory(dir: string, inventory: Inventory): Promise<void> {
  await writeFile(join(dir, 'inventory.yml'), serializeInventory(inventory));
}

export async function writeFinding(dir: string, finding: Finding): Promise<string> {
  const path = join(dir, 'findings', findingFileName(finding));
  await writeFile(path, serializeFinding(finding));
  return path;
}

export async function appendKnowledge(dir: string, line: string): Promise<void> {
  const current = await readFile(join(dir, 'knowledge.md'), 'utf8').catch(() => KNOWLEDGE_TEMPLATE);
  await writeFile(join(dir, 'knowledge.md'), `${current.trimEnd()}\n- ${line.trim()}\n`);
}
