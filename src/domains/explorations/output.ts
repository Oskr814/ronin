import { SEVERITIES, SIGNALS, VIEWPORTS, type Severity, type Signal, type ViewportName } from './memory.js';

// What an explore-function run writes (result.json) and what the evaluator
// writes (verdicts.json), and their validation — same pattern as the
// external review's findings.json (domains/review/output.ts): the agent only writes
// a file, the supervisor checks every field and drops what doesn't hold.

export interface Evidence {
  tipo: 'screenshot' | 'consola' | 'red' | 'medicion';
  // screenshot: a path inside the run's output dir. Others: what was seen.
  detalle: string;
  nota?: string;
}

export interface Candidate {
  tipo: 'hallazgo' | 'idea';
  titulo: string;
  senal: Signal | 'idea';
  gravedad: Severity;
  viewport: ViewportName;
  huella: string;
  pasos: string[];
  observado: string;
  esperado: string;
  evidencia: Evidence[];
  propuesta: string;
  // The "after" of the proposal, inside the run's output dir: a screenshot
  // of the app with a draft change, or a self-contained HTML drawing it.
  despues?: { imagen: string; nota?: string };
  // The draft change used for the "after" screenshot, if one was made.
  parche?: string;
}

export interface TriedTask {
  viewport: ViewportName;
  tarea: string;
  completada: boolean;
  pasos: number;
  notas?: string;
}

export interface FunctionResult {
  tareas: TriedTask[];
  candidatos: Candidate[];
}

export const RESULT_JSON_CONTRACT = `{
  "tareas": [
    { "viewport": "desktop" | "mobile", "tarea": "<what you tried to do, in Spanish>", "completada": true, "pasos": <number of actions it took>, "notas": "<optional>" }
  ],
  "candidatos": [
    {
      "tipo": "hallazgo" | "idea",
      "titulo": "<the consequence a user would notice, in Spanish, ideally under 120 chars and never over 200>",
      "senal": "${SIGNALS.join('" | "')}" | "idea",
      "gravedad": "${SEVERITIES.join('" | "')}",
      "viewport": "desktop" | "mobile",
      "huella": "<function id>|<what fails, 2-4 words>|<consequence, 2-4 words>",
      "pasos": ["<one concrete action per step, max 8>"],
      "observado": "<what happened>",
      "esperado": "<what should have happened>",
      "evidencia": [{ "tipo": "screenshot" | "consola" | "red" | "medicion", "detalle": "<screenshot path, or what you saw>", "nota": "<optional>" }],
      "propuesta": "<one concrete improvement, in Spanish>",
      "despues": { "imagen": "<optional: path of the after — a screenshot of the app with your draft change, or a self-contained .html drawing it>", "nota": "<one-line caption, in Spanish>" },
      "parche": "<optional: path of the .patch with the draft change used for the after screenshot>"
    }
  ]
}`;

// The prompt asks for titles under 120 chars, but the agent often writes a
// few more; cutting there left issues and fichas titled "…vuelve a activarse"
// as "…vuelve…" (redmotos/shoppingcart#840). The title goes whole up to
// 200, which still fits a GitHub issue title (256).
export const LIMITS = { titulo: 200, texto: 1200, paso: 300, pasos: 8, evidencia: 6, propuesta: 800 };

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Over `max`, cut at the last space that fits, never mid-word.
export function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, '')}…`;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`falta "${field}"`);
  return clip(value, max);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`"${field}" inválido: ${String(value)}`);
  return value as T;
}

// A path the agent reports must stay inside the run's own output dir: it is
// later read and published, so "../../.env" must never get through.
export function insideDir(path: unknown, outDir: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  const absolute = path.startsWith('/') ? path : `${outDir}/${path}`;
  const normalized = absolute.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop();
    else if (part !== '.' && part !== '') acc.push(part);
    return acc;
  }, []);
  const result = `/${normalized.join('/')}`;
  return result.startsWith(`${outDir.replace(/\/$/, '')}/`) ? result : undefined;
}

export function parseCandidate(raw: unknown, functionId: string, outDir: string): Candidate {
  if (!isObject(raw)) throw new Error('no es un objeto');
  const tipo = oneOf(raw.tipo, ['hallazgo', 'idea'] as const, 'tipo');
  const senal = tipo === 'idea' ? 'idea' : oneOf(raw.senal, SIGNALS, 'senal');
  const pasos = (Array.isArray(raw.pasos) ? raw.pasos : []).slice(0, LIMITS.pasos).map((p: unknown, i: number) => text(p, `pasos[${i}]`, LIMITS.paso));
  if (tipo === 'hallazgo' && pasos.length === 0) throw new Error('un hallazgo necesita los pasos para reproducirlo');
  const evidencia: Evidence[] = (Array.isArray(raw.evidencia) ? raw.evidencia : []).slice(0, LIMITS.evidencia).flatMap((e: unknown): Evidence[] => {
    if (!isObject(e)) return [];
    const kind = ['screenshot', 'consola', 'red', 'medicion'].includes(e.tipo) ? (e.tipo as Evidence['tipo']) : undefined;
    if (!kind) return [];
    const detalle = kind === 'screenshot' ? insideDir(e.detalle, outDir) : typeof e.detalle === 'string' ? e.detalle.trim().slice(0, LIMITS.texto) : undefined;
    if (!detalle) return [];
    return [{ tipo: kind, detalle, ...(typeof e.nota === 'string' && e.nota.trim() ? { nota: e.nota.trim().slice(0, LIMITS.paso) } : {}) }];
  });
  if (tipo === 'hallazgo' && evidencia.length === 0) throw new Error('un hallazgo necesita evidencia observada usando la app');
  const afterPath = isObject(raw.despues) ? insideDir(raw.despues.imagen, outDir) : undefined;
  const despues = afterPath && /\.(png|jpe?g|html?)$/i.test(afterPath)
    ? { imagen: afterPath, ...(typeof raw.despues.nota === 'string' && raw.despues.nota.trim() ? { nota: raw.despues.nota.trim().slice(0, LIMITS.paso) } : {}) }
    : undefined;
  if (tipo === 'idea' && !despues) throw new Error('una idea necesita la imagen del después');
  const huellaParts = String(raw.huella ?? '').split('|').map((p) => p.trim()).filter(Boolean);
  if (huellaParts.length < 2) throw new Error('"huella" necesita al menos "<función>|<qué falla>"');
  if (huellaParts[0] !== functionId) huellaParts.unshift(functionId);
  return {
    tipo,
    titulo: text(raw.titulo, 'titulo', LIMITS.titulo),
    senal,
    gravedad: tipo === 'idea' ? 'pulido' : oneOf(raw.gravedad, SEVERITIES, 'gravedad'),
    viewport: oneOf(raw.viewport, VIEWPORTS, 'viewport'),
    huella: huellaParts.join('|'),
    pasos,
    observado: tipo === 'idea' ? (typeof raw.observado === 'string' ? raw.observado.trim().slice(0, LIMITS.texto) : '') : text(raw.observado, 'observado', LIMITS.texto),
    esperado: tipo === 'idea' ? (typeof raw.esperado === 'string' ? raw.esperado.trim().slice(0, LIMITS.texto) : '') : text(raw.esperado, 'esperado', LIMITS.texto),
    evidencia,
    propuesta: text(raw.propuesta, 'propuesta', LIMITS.propuesta),
    ...(despues ? { despues } : {}),
    ...(insideDir(raw.parche, outDir) ? { parche: insideDir(raw.parche, outDir) } : {}),
  };
}

export function parseFunctionResult(raw: string, functionId: string, outDir: string): { result: FunctionResult; dropped: string[] } {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('result.json no contiene un objeto JSON');
  const dropped: string[] = [];
  const tareas: TriedTask[] = (Array.isArray(parsed.tareas) ? parsed.tareas : []).flatMap((t: unknown): TriedTask[] => {
    if (!isObject(t) || !VIEWPORTS.includes(t.viewport) || typeof t.tarea !== 'string') return [];
    return [{
      viewport: t.viewport,
      tarea: t.tarea.trim().slice(0, LIMITS.paso),
      completada: t.completada === true,
      pasos: Number.isFinite(t.pasos) ? Number(t.pasos) : 0,
      ...(typeof t.notas === 'string' && t.notas.trim() ? { notas: t.notas.trim().slice(0, LIMITS.texto) } : {}),
    }];
  });
  const candidatos: Candidate[] = [];
  (Array.isArray(parsed.candidatos) ? parsed.candidatos : []).forEach((c: unknown, i: number) => {
    try {
      candidatos.push(parseCandidate(c, functionId, outDir));
    } catch (error) {
      dropped.push(`candidato ${i}: ${(error as Error).message}`);
    }
  });
  return { result: { tareas, candidatos }, dropped };
}

export interface Verdict {
  index: number;
  veredicto: 'mantener' | 'descartar';
  motivo: string;
  gravedad?: Severity;
  entorno?: boolean;
}

export const VERDICTS_JSON_CONTRACT = `{
  "veredictos": [
    { "index": <candidate index>, "veredicto": "mantener" | "descartar", "motivo": "<one sentence, in Spanish>", "gravedad": "<optional corrected severity: ${SEVERITIES.join(' | ')}>", "entorno": <optional: true when it is a problem of the dev environment, not of the app> }
  ]
}`;

// A candidate the evaluator left without a verdict is dropped: the
// evaluator is the gate, and silence doesn't pass it.
export function parseVerdicts(raw: string, count: number): Verdict[] {
  const parsed: unknown = JSON.parse(raw);
  const list = isObject(parsed) && Array.isArray(parsed.veredictos) ? parsed.veredictos : [];
  const byIndex = new Map<number, Verdict>();
  for (const v of list) {
    if (!isObject(v) || !Number.isInteger(v.index) || v.index < 0 || v.index >= count) continue;
    if (v.veredicto !== 'mantener' && v.veredicto !== 'descartar') continue;
    byIndex.set(v.index, {
      index: v.index,
      veredicto: v.veredicto,
      motivo: typeof v.motivo === 'string' ? v.motivo.trim().slice(0, LIMITS.paso) : '',
      ...(SEVERITIES.includes(v.gravedad) ? { gravedad: v.gravedad } : {}),
      ...(v.entorno === true ? { entorno: true } : {}),
    });
  }
  return Array.from({ length: count }, (_, index) => byIndex.get(index) ?? { index, veredicto: 'descartar', motivo: 'el evaluador no dio veredicto' });
}

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

// What gets published from one run: findings most severe first up to
// maxFindings, then at most maxIdeas ideas — ideas never take a finding's
// place. Returns what was kept and what was cut.
export function capCandidates<T extends Pick<Candidate, 'tipo' | 'gravedad'>>(candidates: T[], maxFindings: number, maxIdeas: number): { kept: T[]; cut: T[] } {
  const findings = candidates.filter((c) => c.tipo === 'hallazgo').sort((a, b) => SEVERITY_RANK[a.gravedad] - SEVERITY_RANK[b.gravedad]);
  const ideas = candidates.filter((c) => c.tipo === 'idea');
  const kept = [...findings.slice(0, maxFindings), ...ideas.slice(0, maxIdeas)];
  return { kept, cut: candidates.filter((c) => !kept.includes(c)) };
}

const SIGNAL_LABEL: Record<Signal | 'idea', string> = {
  'muchos-pasos': 'Muchos pasos',
  'ida-y-vuelta': 'Idas y vueltas',
  'pantalla-cargada': 'Pantalla cargada',
  bug: 'Bug',
  'patron-global': 'Patrón de UX global',
  inconsistencia: 'UI inconsistente',
  'ui-muerta': 'UI muerta',
  idea: 'Idea',
};

export interface FindingImage {
  url: string;
  nota?: string;
}

// Shown at a readable size: a full-page phone screenshot is very tall.
export function image(img: FindingImage, viewport: ViewportName): string {
  const alt = (img.nota ?? 'captura').replace(/"/g, "'");
  return `<img src="${img.url}" alt="${alt}" width="${viewport === 'mobile' ? 320 : 720}">`;
}

// The body of the finding's file in the repo. The screenshots are linked
// from the evidence branch (evidence-store.ts); without them (not published)
// their captions still say what they showed.
export function renderFindingBody(
  c: Candidate,
  opts: { functionName: string; patch?: string; antes?: FindingImage[]; despues?: FindingImage },
): string {
  const lines = [`## ${c.titulo}`, '', `**${SIGNAL_LABEL[c.senal]}** · gravedad \`${c.gravedad}\` · ${c.viewport} · ${opts.functionName}`, ''];
  if (c.pasos.length > 0) lines.push('### Cómo reproducirlo', '', ...c.pasos.map((p, i) => `${i + 1}. ${p}`), '');
  if (c.observado) lines.push(`**Qué pasa:** ${c.observado}`, '');
  if (c.esperado) lines.push(`**Qué se esperaba:** ${c.esperado}`, '');
  const evidence = c.evidencia.filter((e) => e.tipo !== 'screenshot');
  const shots = c.evidencia.filter((e) => e.tipo === 'screenshot');
  if (evidence.length > 0 || shots.length > 0) {
    lines.push('### Evidencia', '');
    for (const e of evidence) lines.push(`- ${e.tipo}: ${e.detalle}${e.nota ? ` — ${e.nota}` : ''}`);
    if (opts.antes?.length) {
      lines.push('');
      for (const img of opts.antes) lines.push(`**Antes**${img.nota ? `: ${img.nota}` : ''}`, '', image(img, c.viewport), '');
    } else {
      for (const s of shots) lines.push(`- captura${s.nota ? `: ${s.nota}` : ''}`);
      lines.push('');
    }
  }
  lines.push('### Propuesta', '', c.propuesta, '');
  if (opts.despues) lines.push(`**Después**${opts.despues.nota ? `: ${opts.despues.nota}` : ''}`, '', image(opts.despues, c.viewport), '');
  if (opts.patch) lines.push('<details><summary>Cambio borrador usado para el después</summary>', '', '```diff', opts.patch.trim(), '```', '', '</details>', '');
  return lines.join('\n');
}

// A finding body read back into its parts, for the dashboard (#93): the
// inverse of renderFindingBody, also after replaceProposal,
// replaceAfterImage and replaceDraftPatch touched it. A part a body doesn't
// have (an idea without steps, a finding without an after) comes back empty.
export interface FindingBodyParts {
  functionName: string;
  pasos: string[];
  observado: string;
  esperado: string;
  evidencia: Array<{ tipo: string; detalle: string }>;
  antes: FindingImage[];
  propuesta: string;
  despues?: FindingImage;
  parche?: string;
}

const IMG_SRC_RE = /<img src="([^"]+)"/;

function images(text: string, label: string): FindingImage[] {
  const re = new RegExp(`\\*\\*${label}\\*\\*(?:: ([^\\n]*))?\\n\\n(<img [^\\n]*>)`, 'g');
  return [...text.matchAll(re)].flatMap((m) => {
    const url = IMG_SRC_RE.exec(m[2])?.[1];
    return url ? [{ url, ...(m[1]?.trim() ? { nota: m[1].trim() } : {}) }] : [];
  });
}

function section(body: string, heading: string): string {
  const start = body.indexOf(`\n### ${heading}\n`);
  if (start < 0) return '';
  const from = start + heading.length + 6;
  const next = body.indexOf('\n### ', from);
  return body.slice(from, next < 0 ? undefined : next);
}

export function parseFindingBody(body: string): FindingBodyParts {
  const text = `\n${body.replace(/\r\n/g, '\n')}`;
  const header = /^\*\*[^*\n]+\*\* · [^\n]* · (?:desktop|mobile) · ([^\n]+)$/m.exec(text);
  const beforeEvidence = text.split(/\n### (?:Evidencia|Propuesta)\n/)[0];
  const field = (label: string) => new RegExp(`\\*\\*${label}:\\*\\* ([\\s\\S]*?)(?=\\n\\n\\*\\*Qué se esperaba:\\*\\*|\\n\\n### |\\n*$)`).exec(beforeEvidence)?.[1].trim() ?? '';
  const evidence = section(text, 'Evidencia');
  const proposal = section(text, 'Propuesta');
  const patch = /```diff\n([\s\S]*?)\n```/.exec(proposal)?.[1];
  const despues = images(proposal, 'Después')[0];
  return {
    functionName: header?.[1].trim() ?? '',
    pasos: [...section(text, 'Cómo reproducirlo').matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1].trim()),
    observado: field('Qué pasa'),
    esperado: field('Qué se esperaba'),
    evidencia: [...evidence.matchAll(/^- ([\w-]+): (.*)$/gm)].filter((m) => m[1] !== 'captura').map((m) => ({ tipo: m[1], detalle: m[2].trim() })),
    antes: images(evidence, 'Antes'),
    propuesta: proposal.split(/\n\*\*Después\*\*|\n<details>/)[0].trim(),
    ...(despues ? { despues } : {}),
    ...(patch ? { parche: patch } : {}),
  };
}

const AFTER_RE = /\*\*Después\*\*[^\n]*\n\n<img [^\n]*>\n?/;

// The finding body with its "after" replaced by a new image — or added at
// the end of the proposal when it had none.
export function replaceAfterImage(body: string, img: FindingImage, viewport: ViewportName): string {
  const block = `**Después**${img.nota ? `: ${img.nota}` : ''}\n\n${image(img, viewport)}\n`;
  if (AFTER_RE.test(body)) return body.replace(AFTER_RE, block);
  const proposal = body.indexOf('### Propuesta');
  if (proposal < 0) return `${body.trimEnd()}\n\n${block}`;
  const next = body.indexOf('\n<details>', proposal);
  return next < 0 ? `${body.trimEnd()}\n\n${block}` : `${body.slice(0, next).trimEnd()}\n\n${block}${body.slice(next)}`;
}

// Where the finding's current after lives in the evidence branch, read off
// its link — so a redo overwrites that file instead of adding a second one.
export function afterImagePath(body: string): string | undefined {
  const block = body.match(AFTER_RE)?.[0];
  const src = block?.match(/<img src="https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]+\/([^"?]+)/)?.[1];
  return src ? src.split('/').map(decodeURIComponent).join('/') : undefined;
}

const PATCH_RE = /<details><summary>Cambio borrador usado para el después<\/summary>[\s\S]*?<\/details>\n?/;

// The finding body with the draft change behind a new after, so the diff
// shown always matches the image above it.
export function replaceDraftPatch(body: string, patch: string): string {
  const block = ['<details><summary>Cambio borrador usado para el después</summary>', '', '```diff', patch.trim(), '```', '', '</details>', ''].join('\n');
  return PATCH_RE.test(body) ? body.replace(PATCH_RE, block) : `${body.trimEnd()}\n\n${block}`;
}

// The proposal section of a finding body with new text.
export function replaceProposal(body: string, propuesta: string): string {
  return body.replace(/(### Propuesta\n\n)[\s\S]*?(?=\n\*\*Después\*\*|\n<details>|$)/, (_m, head: string) => `${head}${propuesta.trim()}\n`);
}

// What explore-redo-after writes: the new after, inside its output dir.
export function parseRedoResult(raw: string, outDir: string): { imagen: string; nota?: string } {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('el resultado no es un objeto JSON');
  const imagen = insideDir(parsed.imagen, outDir);
  if (!imagen || !/\.(png|jpe?g|html?)$/i.test(imagen)) throw new Error('el resultado no trae la imagen del después');
  return { imagen, ...(typeof parsed.nota === 'string' && parsed.nota.trim() ? { nota: parsed.nota.trim().slice(0, LIMITS.paso) } : {}) };
}
