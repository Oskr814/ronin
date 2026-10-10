// Contract between the external-review agent and the supervisor: the agent
// writes one JSON object of this shape, the supervisor validates it here and
// is the only one that publishes anything — see
// docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md §4.
// Everything in it derives from untrusted PR content, so validation is
// defensive: one bad finding is dropped (with a reason for the log) and never
// takes the rest of the review down with it.

export type FindingType = 'bug' | 'decision' | 'improvement';
export type FindingSeverity = 'critical' | 'important' | 'minor';

export interface CodeLocation {
  path: string;
  line: number;
}

export interface ReviewFinding {
  path: string;
  line: number;
  startLine?: number;
  type: FindingType;
  severity: FindingSeverity;
  category: string;
  title: string;
  scenario?: string;
  impact: string;
  evidence: Array<CodeLocation & { note: string }>;
  verification: { status: 'verified' | 'reasoned'; reason?: string; test?: { path: string; code: string; output: string } };
  suggestion?: { kind: 'replace'; code: string } | { kind: 'text'; text: string };
  affectedCode: string;
  extraLocations?: CodeLocation[];
  detail?: string;
  mentionId?: number;
}

export interface ExternalReviewOutput {
  findings: ReviewFinding[];
  resolveThreads: Array<{ threadId: string; reason: string }>;
  mentionReplies: Array<{ commentId: number; kind: 'issue' | 'review'; body: string }>;
}

// The shape above, as the external-review prompt shows it to the agent. Kept
// next to the types so a contract change updates both in the same diff.
export const FINDINGS_JSON_CONTRACT = `{
  "findings": [
    {
      "path": "repo-relative path of the file the finding is anchored to",
      "line": 123,                       // line in the PR head version of that file
      "startLine": 120,                  // optional, for a multi-line range (max 10 lines for a replace suggestion)
      "type": "bug" | "decision" | "improvement",
      "severity": "critical" | "important" | "minor",
      "category": "short free text, e.g. Concurrencia",
      "title": "the problem in one sentence (max 120 chars)",
      "scenario": "Given X, when Y, Z happens; W was expected (max 400 chars; required for bug and decision)",
      "impact": "what breaks and for whom, one line (max 200 chars)",
      "evidence": [{ "path": "...", "line": 45, "note": "why this line matters" }],
      "verification": { "status": "reasoned", "reason": "optional, one line" },
      "suggestion": { "kind": "replace", "code": "exact replacement for lines startLine..line" }
                  | { "kind": "text", "text": "one concrete fix, no alternatives" },   // optional
      "affectedCode": "the current code at the anchor, a few lines",
      "extraLocations": [{ "path": "...", "line": 7 }],   // optional: other instances of a systemic finding
      "detail": "optional longer explanation (max 1500 chars)",
      "mentionId": 123                   // optional: id of the mention that asked for this
    }
  ],
  "resolveThreads": [{ "threadId": "id of one of your open threads listed above", "reason": "what code change addressed it" }],
  "mentionReplies": [{ "commentId": 123, "kind": "issue" | "review", "body": "your reply" }]
}`;

export const LIMITS = {
  title: 120,
  category: 40,
  scenario: 400,
  impact: 200,
  note: 200,
  affectedCode: 1200,
  suggestion: 2000,
  detail: 1500,
  reason: 300,
  testCode: 3000,
  testOutput: 1500,
  replyBody: 2000,
  evidence: 6,
  extraLocations: 20,
} as const;

// A GitHub suggestion block replaces exactly the anchored range — past a
// handful of lines it stops being a "one click" fix and becomes a rewrite.
const MAX_SUGGESTION_SPAN = 10;

const TYPES: readonly FindingType[] = ['bug', 'decision', 'improvement'];
const SEVERITIES: readonly FindingSeverity[] = ['critical', 'important', 'minor'];

class InvalidField extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InvalidField(`${field} faltante o vacío`);
  return truncate(value, max);
}

function optStr(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? truncate(value, max) : undefined;
}

function posInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InvalidField(`${field} no es un entero positivo`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new InvalidField(`${field} inválido: ${String(value)}`);
  return value as T;
}

// Repo-relative only: an absolute path or a parent-directory escape can't be
// anchored on the PR and has no business in a link we render.
function repoPath(value: unknown, field: string): string {
  const path = str(value, field, 500);
  if (path.startsWith('/') || path.split('/').includes('..')) throw new InvalidField(`${field} no es una ruta relativa al repo`);
  return path;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Lenient: a malformed entry inside a list is skipped, never fatal for its
// parent finding.
function locations<T>(value: unknown, max: number, parse: (raw: Record<string, unknown>) => T): T[] {
  const result: T[] = [];
  for (const raw of asArray(value)) {
    if (result.length >= max) break;
    if (!isObject(raw)) continue;
    try {
      result.push(parse(raw));
    } catch {
      // skip
    }
  }
  return result;
}

function parseFinding(raw: unknown, mentionIds: Set<number>): ReviewFinding {
  if (!isObject(raw)) throw new InvalidField('no es un objeto');
  const type = oneOf(raw.type, TYPES, 'type');
  const line = posInt(raw.line, 'line');
  const startLine = raw.startLine == null ? undefined : posInt(raw.startLine, 'startLine');
  if (startLine != null && startLine > line) throw new InvalidField('startLine posterior a line');

  const scenario = optStr(raw.scenario, LIMITS.scenario);
  if (type !== 'improvement' && scenario == null) throw new InvalidField(`scenario obligatorio para ${type}`);

  const finding: ReviewFinding = {
    path: repoPath(raw.path, 'path'),
    line,
    ...(startLine != null ? { startLine } : {}),
    type,
    severity: oneOf(raw.severity, SEVERITIES, 'severity'),
    category: str(raw.category, 'category', LIMITS.category),
    title: str(raw.title, 'title', LIMITS.title),
    ...(scenario != null ? { scenario } : {}),
    impact: str(raw.impact, 'impact', LIMITS.impact),
    evidence: locations(raw.evidence, LIMITS.evidence, (e) => ({
      path: repoPath(e.path, 'evidence.path'),
      line: posInt(e.line, 'evidence.line'),
      note: str(e.note, 'evidence.note', LIMITS.note),
    })),
    verification: parseVerification(raw.verification),
    affectedCode: str(raw.affectedCode, 'affectedCode', LIMITS.affectedCode),
  };

  const suggestion = parseSuggestion(raw.suggestion, startLine ?? line, line);
  if (suggestion) finding.suggestion = suggestion;
  if (raw.extraLocations != null) {
    finding.extraLocations = locations(raw.extraLocations, LIMITS.extraLocations, (l) => ({
      path: repoPath(l.path, 'extraLocations.path'),
      line: posInt(l.line, 'extraLocations.line'),
    }));
  }
  const detail = optStr(raw.detail, LIMITS.detail);
  if (detail) finding.detail = detail;
  // A mentionId exempts a finding from the scope rules (stage 2), so it must
  // point at a mention that actually triggered this run.
  if (typeof raw.mentionId === 'number' && mentionIds.has(raw.mentionId)) finding.mentionId = raw.mentionId;
  return finding;
}

function parseVerification(raw: unknown): ReviewFinding['verification'] {
  if (!isObject(raw) || raw.status !== 'verified') {
    const reason = isObject(raw) ? optStr(raw.reason, LIMITS.reason) : undefined;
    return reason ? { status: 'reasoned', reason } : { status: 'reasoned' };
  }
  // "verified" claims a failing test was run — without the test attached it
  // is just an assertion, so it degrades to reasoned.
  if (!isObject(raw.test)) return { status: 'reasoned' };
  try {
    return {
      status: 'verified',
      test: {
        path: repoPath(raw.test.path, 'test.path'),
        code: str(raw.test.code, 'test.code', LIMITS.testCode),
        output: str(raw.test.output, 'test.output', LIMITS.testOutput),
      },
    };
  } catch {
    return { status: 'reasoned' };
  }
}

function parseSuggestion(raw: unknown, startLine: number, line: number): ReviewFinding['suggestion'] {
  if (!isObject(raw)) return undefined;
  if (raw.kind === 'replace' && typeof raw.code === 'string') {
    const code = truncate(raw.code, LIMITS.suggestion);
    return line - startLine > MAX_SUGGESTION_SPAN ? { kind: 'text', text: `\`\`\`\n${code}\n\`\`\`` } : { kind: 'replace', code };
  }
  const text = optStr(raw.text, LIMITS.suggestion);
  return raw.kind === 'text' && text ? { kind: 'text', text } : undefined;
}

export function parseReviewOutput(
  raw: string,
  ctx: { mentionIds: Set<number>; openThreadIds: Set<string> },
): { output: ExternalReviewOutput; dropped: Array<{ index: number; reason: string }> } {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('findings.json no contiene un objeto JSON');

  const dropped: Array<{ index: number; reason: string }> = [];
  const findings: ReviewFinding[] = [];
  asArray(parsed.findings).forEach((rawFinding, index) => {
    try {
      findings.push(parseFinding(rawFinding, ctx.mentionIds));
    } catch (error) {
      dropped.push({ index, reason: (error as Error).message });
    }
  });

  const resolveThreads: ExternalReviewOutput['resolveThreads'] = [];
  for (const entry of asArray(parsed.resolveThreads)) {
    if (isObject(entry) && typeof entry.threadId === 'string' && ctx.openThreadIds.has(entry.threadId)) {
      resolveThreads.push({ threadId: entry.threadId, reason: optStr(entry.reason, LIMITS.reason) ?? '' });
    } else {
      dropped.push({ index: -1, reason: `resolveThreads: thread ajeno o inválido (${isObject(entry) ? String(entry.threadId) : '?'})` });
    }
  }

  const mentionReplies: ExternalReviewOutput['mentionReplies'] = [];
  for (const entry of asArray(parsed.mentionReplies)) {
    const body = isObject(entry) ? optStr(entry.body, LIMITS.replyBody) : undefined;
    if (
      isObject(entry) &&
      typeof entry.commentId === 'number' &&
      ctx.mentionIds.has(entry.commentId) &&
      (entry.kind === 'issue' || entry.kind === 'review') &&
      body
    ) {
      mentionReplies.push({ commentId: entry.commentId, kind: entry.kind, body });
    } else {
      dropped.push({ index: -1, reason: 'mentionReplies: mención ajena o entrada inválida' });
    }
  }

  return { output: { findings, resolveThreads, mentionReplies }, dropped };
}
