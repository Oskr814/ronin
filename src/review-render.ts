import type { ReviewFinding, FindingType, FindingSeverity } from './review-output.js';

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

const TYPE_EMOJI: Record<FindingType, string> = { bug: '🐞', decision: '❓', improvement: '🧹' };
const TYPE_LABEL: Record<FindingType, string> = { bug: 'Defecto', decision: 'Decisión', improvement: 'Mejora' };
const SEVERITY_EMOJI: Record<FindingSeverity, string> = { critical: '🔴', important: '🟠', minor: '🟡' };
const SEVERITY_LABEL: Record<FindingSeverity, string> = { critical: 'Crítico', important: 'Importante', minor: 'Menor' };

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
function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'otro';
}

export function findingMarker(finding: ReviewFinding, ctx: RenderContext): string {
  const scope = ctx.scopeOf?.(finding) ?? 'changed';
  return (
    `<!-- ronin:finding v=2 type=${finding.type} severity=${finding.severity} category=${slug(finding.category)} ` +
    `verification=${finding.verification.status} mode=${ctx.mode} scope=${scope} criteria=${ctx.criteriaHash} -->`
  );
}

function verificationLine(finding: ReviewFinding): string {
  if (finding.verification.status === 'verified') return '**Verificación:** comprobado con un test que falla (ver abajo).';
  const reason = finding.verification.reason ? ` — ${inline(finding.verification.reason)}` : '';
  return `**Verificación:** razonado, no ejecutado${reason}.`;
}

function suggestionBlock(finding: ReviewFinding): string | undefined {
  if (!finding.suggestion) return undefined;
  if (finding.suggestion.kind === 'replace') return fenced(neutralizeMentions(finding.suggestion.code), 'suggestion');
  return `**Corrección:** ${neutralizeMentions(finding.suggestion.text)}`;
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
  lines.push('', PROMPT_TYPE_LINE[finding.type], '');
  if (finding.scenario) lines.push(`Escenario: ${inline(finding.scenario)}`);
  lines.push(`Impacto: ${inline(finding.impact)}`, '', 'Código actual:', fenced(neutralizeMentions(finding.affectedCode), languageOf(finding.path)));
  if (finding.suggestion?.kind === 'replace') {
    lines.push('', 'Corrección propuesta:', fenced(neutralizeMentions(finding.suggestion.code), languageOf(finding.path)));
  } else if (finding.suggestion?.kind === 'text') {
    lines.push('', `Corrección propuesta: ${neutralizeMentions(finding.suggestion.text)}`);
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
  if (finding.scenario) visible.push(`**Escenario:** ${inline(finding.scenario)}`);
  visible.push(`**Impacto:** ${inline(finding.impact)}`);
  if (finding.evidence.length > 0) {
    visible.push(`**Evidencia:** ${finding.evidence.map((e) => `${locationLink(ctx, e.path, e.line)} ${inline(e.note)}`).join(' · ')}`);
  }
  if (finding.extraLocations?.length) {
    visible.push(`**También en:** ${finding.extraLocations.map((l) => locationLink(ctx, l.path, l.line)).join(' · ')}`);
  }
  visible.push(verificationLine(finding));
  if (finding.type === 'decision') visible.push('**Si es intencional:** resolvé el hilo.');
  parts.push(visible.join('\n'));

  const suggestion = suggestionBlock(finding);
  if (suggestion) parts.push('', suggestion);

  if (finding.verification.status === 'verified' && finding.verification.test) {
    const { test } = finding.verification;
    parts.push('', details(`Test que lo comprueba (\`${test.path}\`)`, `${fenced(neutralizeMentions(test.code), languageOf(test.path))}\n\n${fenced(neutralizeMentions(test.output))}`));
  }
  if (includeDetail && finding.detail) parts.push('', details('Detalle', neutralizeMentions(finding.detail)));
  if (includePrompt) parts.push('', details('Prompt para agentes de IA 🤖', renderAgentPrompt(finding)));
  return parts.join('\n');
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
    '| | Severidad | Hallazgo |',
    '|---|---|---|',
    ...all.map((f) => `| ${TYPE_EMOJI[f.type]} | ${SEVERITY_EMOJI[f.severity]} ${SEVERITY_LABEL[f.severity]} | ${tableCell(f.title)} (${locationLink(ctx, f.path, f.line)}) |`),
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
