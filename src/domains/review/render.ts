import type { ReviewFinding, FindingType, FindingSeverity, FindingOrigin, CodeLocation } from './output.js';

// Every comment the external review publishes is rendered here from the
// validated findings.json fields — never free-form text from the model — so
// the format is the same on every run and the emoji always matches the
// severity. See docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md
// ("Formato del comentario").

export interface RenderContext {
  repo: string;
  headSha: string;
  criteriaHash: string;
  mode: 'full' | 'incremental';
  // Stage 1 has no incremental scope yet: every finding is on changed code.
  scopeOf?: (finding: ReviewFinding) => 'changed' | 'reviewed';
}

export type ClosingState = 'lgtm' | 'confirmed' | { open: Array<{ url: string; title: string }> };

// A decision's title is already a yes/no question ("¿…?"), so a ❓ in front
// of it says nothing new.
const TYPE_EMOJI: Record<FindingType, string> = { bug: '🐞', decision: '', improvement: '💡' };
const TYPE_LABEL: Record<FindingType, string> = { bug: 'Defecto', decision: 'Decisión', improvement: 'Mejora' };
const SEVERITY_EMOJI: Record<FindingSeverity, string> = { critical: '🔴', important: '🟠', minor: '🟡' };
const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: 'Crítico', important: 'Importante', minor: 'Menor' };

const ORIGIN_LABEL: Record<FindingOrigin, string> = {
  new: 'Lo introduce este PR',
  worsened: 'Lo empeora este PR',
  preexisting: 'Ya existía antes de este PR',
};

const PROMPT_TYPE_LINE: Record<FindingType, string> = {
  bug: 'Tipo: defecto — hay un escenario de falla concreto.',
  decision: 'Tipo: decisión a confirmar — preguntá antes de cambiar si el comportamiento es intencional.',
  improvement: 'Tipo: mejora opcional.',
};
const PROMPT_VERIFY_FIRST =
  'Antes de cambiar: confirmá que el escenario es posible leyendo el código. Si no lo es, no cambies nada y explicá por qué.';

// GitHub's own review body limit is 65 536 characters; this leaves headroom.
export const SUMMARY_MAX = 60_000;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  cs: 'csharp', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', sql: 'sql',
  xml: 'xml', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', md: 'markdown',
};

// Everything published here derives from untrusted PR content: a bare
// @handle would ping a real GitHub user or team. A zero-width joiner after
// the "@" keeps it readable without notifying anyone. An "@" preceded by a
// word character (an email address) is left alone.
export function neutralizeMentions(text: string): string {
  return text.replace(/(^|[^\w@])@(?=[A-Za-z0-9])/g, '$1@‍');
}

// A fence one backtick longer than the longest backtick run inside the
// content, so code containing ``` can't close the block early.
function fenceFor(content: string, minimum = 3): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

function fenced(content: string, info = '', minimum = 3): string {
  const fence = fenceFor(content, minimum);
  return `${fence}${info}\n${content}\n${fence}`;
}

function languageOf(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[extension] ?? '';
}

// Collapsed to one line: these values go into table cells and single-line
// markdown fields.
function inline(text: string): string {
  return neutralizeMentions(text.replace(/\s*\n\s*/g, ' ').trim());
}

function blobUrl(ctx: RenderContext, path: string, line: number): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${ctx.repo}/blob/${ctx.headSha}/${encodedPath}#L${line}`;
}

function locationLink(ctx: RenderContext, path: string, line: number): string {
  return `[\`${path}:${line}\`](${blobUrl(ctx, path, line)})`;
}

// Kept to characters that can't end an HTML comment ("--", ">") or split
// the key=value list (spaces).
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'otro';
}

// The review-level marker, first line of every review body ronin publishes:
// the last reviewed SHA is read back from it (github.ts,
// getLastReviewedShaFromGitHub), since the bot's other reviews — replies to
// inline comments — carry a commit_id too.
export function reviewMarker(ctx: RenderContext): string {
  return `<!-- ronin:review v=2 sha=${ctx.headSha} mode=${ctx.mode} criteria=${ctx.criteriaHash} -->`;
}

export function findingMarker(finding: ReviewFinding, ctx: RenderContext): string {
  const scope = ctx.scopeOf?.(finding) ?? 'changed';
  return (
    `<!-- ronin:finding v=2 type=${finding.type} severity=${finding.severity} category=${slug(finding.category)} ` +
    `verification=${finding.verification.status} mode=${ctx.mode} scope=${scope} criteria=${ctx.criteriaHash} -->`
  );
}

function sentence(text: string): string {
  const t = inline(text);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function originLine(finding: ReviewFinding): string | undefined {
  if (!finding.origin) return undefined;
  const label = ORIGIN_LABEL[finding.origin.kind];
  return finding.origin.note ? `**${label}:** ${sentence(finding.origin.note)}` : `**${label}.**`;
}

// "→ result. Se esperaba: expected." — the outcome of the steps, or the
// whole scenario when the model gave no steps.
function scenarioOutcome(finding: ReviewFinding): string {
  const { result, expected } = finding.scenario!;
  return `${sentence(result)}${expected ? ` Se esperaba: ${sentence(expected)}` : ''}`;
}

function scenarioBlock(finding: ReviewFinding): string {
  const { steps } = finding.scenario!;
  if (steps.length === 0) return `**Cómo pasa:** ${scenarioOutcome(finding)}`;
  return ['**Cómo pasa:**', '', ...steps.map((step, i) => `${i + 1}. ${inline(step)}`), '', `→ ${scenarioOutcome(finding)}`].join('\n');
}

function sameLocation(a: CodeLocation, b: CodeLocation): boolean {
  return a.path === b.path && a.line === b.line;
}

// Evidence and the other instances in one line; an instance already linked
// as evidence (or the anchor itself) is not repeated.
function whereLine(finding: ReviewFinding, ctx: RenderContext): string | undefined {
  const parts = finding.evidence.map((e) => `${locationLink(ctx, e.path, e.line)} ${inline(e.note)}`);
  const anchor = { path: finding.path, line: finding.line };
  const extra = (finding.extraLocations ?? []).filter(
    (l) => !sameLocation(l, anchor) && !finding.evidence.some((e) => sameLocation(e, l)),
  );
  if (extra.length > 0) parts.push(`también ${extra.map((l) => locationLink(ctx, l.path, l.line)).join(', ')}`);
  return parts.length > 0 ? `**Dónde:** ${parts.join(' · ')}` : undefined;
}

// Only a test that was actually run earns a visible line; a reasoned
// finding says so inside the detail.
function reasonedNote(finding: ReviewFinding): string | undefined {
  if (finding.verification.status === 'verified') return undefined;
  const reason = finding.verification.reason ? ` — ${inline(finding.verification.reason).replace(/[.\s]+$/, '')}` : '';
  return `**Verificación:** razonado, no ejecutado${reason}.`;
}

function fixBlock(finding: ReviewFinding): string | undefined {
  const parts: string[] = [];
  if (finding.fix) parts.push(`**Corrección:** ${neutralizeMentions(finding.fix)}`);
  if (finding.suggestion) {
    const info = finding.suggestion.kind === 'replace' ? 'suggestion' : languageOf(finding.path);
    parts.push(fenced(neutralizeMentions(finding.suggestion.code), info));
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

// The body of the copyable prompt, without its outer fence — shared by the
// per-comment prompt and the combined one in the review summary.
function agentPromptBody(finding: ReviewFinding): string {
  const lines = [
    `Revisá y, si corresponde, corregí este hallazgo en \`${finding.path}\` (línea ${finding.line}).`,
  ];
  if (finding.extraLocations?.length) {
    lines.push(`También aplica en: ${finding.extraLocations.map((l) => `\`${l.path}:${l.line}\``).join(', ')}.`);
  }
  lines.push('', PROMPT_TYPE_LINE[finding.type]);
  if (finding.origin) lines.push(`Origen: ${ORIGIN_LABEL[finding.origin.kind]}${finding.origin.note ? ` — ${sentence(finding.origin.note)}` : '.'}`);
  lines.push('');
  if (finding.scenario) {
    lines.push('Escenario:', ...finding.scenario.steps.map((step, i) => `${i + 1}. ${inline(step)}`), `Resultado: ${scenarioOutcome(finding)}`);
  }
  lines.push(`Impacto: ${inline(finding.impact)}`, '', 'Código actual:', fenced(neutralizeMentions(finding.affectedCode), languageOf(finding.path)));
  if (finding.fix) lines.push('', `Corrección propuesta: ${neutralizeMentions(finding.fix)}`);
  if (finding.suggestion) {
    lines.push('', finding.fix ? 'Código:' : 'Corrección propuesta:', fenced(neutralizeMentions(finding.suggestion.code), languageOf(finding.path)));
  }
  lines.push('', PROMPT_VERIFY_FIRST);
  return lines.join('\n');
}

export function renderAgentPrompt(finding: ReviewFinding): string {
  const body = agentPromptBody(finding);
  return fenced(body, 'markdown', 4);
}

export function renderCombinedAgentPrompt(findings: ReviewFinding[]): string {
  const sections = findings.map((f, i) => `## ${i + 1}. ${inline(f.title)}\n\n${agentPromptBody(f)}`);
  const body = [
    `Hay ${findings.length} hallazgos de review en este PR. Atendelos de a uno, en orden; cada uno indica si es un defecto, una decisión a confirmar o una mejora opcional.`,
    '',
    ...sections.flatMap((s) => [s, '']),
  ].join('\n').trimEnd();
  return fenced(body, 'markdown', 4);
}

export function renderFindingComment(finding: ReviewFinding, ctx: RenderContext, opts: { includeDetail?: boolean; includePrompt?: boolean } = {}): string {
  const includeDetail = opts.includeDetail ?? true;
  const includePrompt = opts.includePrompt ?? true;
  const parts: string[] = [
    findingMarker(finding, ctx),
    `### ${TYPE_EMOJI[finding.type]}${SEVERITY_EMOJI[finding.severity]} ${inline(finding.title)}`,
    `<sub>${TYPE_LABEL[finding.type]} · ${SEVERITY_LABEL[finding.severity]} · ${inline(finding.category)}</sub>`,
    '',
  ];
  const visible: string[] = [];
  const origin = originLine(finding);
  if (origin) visible.push(origin, '');
  visible.push(finding.scenario ? scenarioBlock(finding) : `**Impacto:** ${inline(finding.impact)}`);
  const where = whereLine(finding, ctx);
  if (where) visible.push('', where);
  if (finding.verification.status === 'verified') visible.push('**Verificación:** ✅ comprobado con un test que falla (ver abajo).');
  if (finding.type === 'decision') visible.push('**Si es intencional:** resolvé el hilo.');
  parts.push(visible.join('\n'));

  const fix = fixBlock(finding);
  if (fix) parts.push('', fix);

  if (finding.verification.status === 'verified' && finding.verification.test) {
    const { test } = finding.verification;
    parts.push('', details(`Test que lo comprueba (\`${test.path}\`)`, `${fenced(neutralizeMentions(test.code), languageOf(test.path))}\n\n${fenced(neutralizeMentions(test.output))}`));
  }
  if (includeDetail) {
    const body = [finding.detail ? neutralizeMentions(finding.detail) : undefined, reasonedNote(finding)].filter(Boolean).join('\n\n');
    if (body) parts.push('', details('Detalle', body));
  }
  if (includePrompt) parts.push('', details('Prompt para agentes de IA 🤖', renderAgentPrompt(finding)));
  return parts.join('\n');
}

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'important', 'minor'];

function bySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function tableCell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

function buildSummary(
  findings: { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] },
  ctx: RenderContext,
  level: 0 | 1 | 2,
): string {
  const all = [...findings.inline, ...findings.outOfDiff];
  const lines = [
    '## Review de ronin',
    `${all.length} ${all.length === 1 ? 'hallazgo' : 'hallazgos'} · commit \`${ctx.headSha.slice(0, 7)}\` · criterio \`${ctx.criteriaHash.slice(0, 7)}\``,
    '',
    '| Tipo | Severidad | Hallazgo |',
    '|---|---|---|',
    ...bySeverity(all).map((f) => `| ${`${TYPE_EMOJI[f.type]} ${TYPE_LABEL[f.type]}`.trim()} | ${SEVERITY_EMOJI[f.severity]} ${SEVERITY_LABEL[f.severity]} | ${tableCell(f.title)} (${locationLink(ctx, f.path, f.line)}) |`),
  ];
  if (findings.outOfDiff.length > 0) {
    lines.push('', '### Fuera del diff', '', 'Estos hallazgos apuntan a líneas que el PR no modifica, así que no se pueden anclar como comentario en la línea.');
    for (const f of findings.outOfDiff) {
      lines.push('', '---', '', renderFindingComment(f, ctx, { includeDetail: level < 2, includePrompt: level < 2 }));
    }
  }
  if (level === 0) lines.push('', details('Prompt para atender todos los hallazgos 🤖', renderCombinedAgentPrompt(all)));
  return lines.join('\n');
}

// Degrades in steps when the body would exceed GitHub's limit: first the
// combined prompt goes, then the per-finding detail and prompts of the
// out-of-diff findings (the inline comments keep theirs).
export function renderReviewSummary(findings: { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] }, ctx: RenderContext): string {
  for (const level of [0, 1, 2] as const) {
    const body = buildSummary(findings, ctx, level);
    if (body.length <= SUMMARY_MAX || level === 2) return body.length <= SUMMARY_MAX ? body : `${body.slice(0, SUMMARY_MAX - 1)}…`;
  }
  throw new Error('unreachable');
}

export function renderClosing(state: ClosingState): string {
  if (state === 'lgtm') return 'LGTM 🚀';
  if (state === 'confirmed') return '✅ Ajustes confirmados, no quedan observaciones pendientes.';
  const items = state.open.map((t) => `- [${tableCell(t.title)}](${t.url})`);
  return [`Sin observaciones nuevas; ${state.open.length === 1 ? 'queda 1 abierta' : `quedan ${state.open.length} abiertas`}:`, '', ...items].join('\n');
}
