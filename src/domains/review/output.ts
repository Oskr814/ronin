import type { CommentKind } from '@platform/github/github.js';

// Contract between the external-review agent and the supervisor: the agent
// writes one JSON object of this shape, the supervisor validates it here and
// is the only one that publishes anything — see
// docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md §4.
// Everything in it derives from untrusted PR content, so validation is
// defensive: one bad finding is dropped (with a reason for the log) and never
// takes the rest of the review down with it.

export type FindingType = 'bug' | 'decision' | 'improvement';
export type FindingSeverity = 'critical' | 'important' | 'minor';
// Whether the PR brought the problem in. It is the first thing a reader
// needs to accept or dismiss a finding, so it is a field, not prose.
export type FindingOrigin = 'new' | 'worsened' | 'preexisting';

// A race or a failure path reads as numbered steps, not one long sentence.
export interface Scenario {
  steps: string[];
  result: string;
  expected?: string;
}

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
  origin?: { kind: FindingOrigin; note?: string };
  scenario?: Scenario;
  impact: string;
  evidence: Array<CodeLocation & { note: string }>;
  verification: { status: 'verified' | 'reasoned'; reason?: string; test?: { path: string; code: string; output: string } };
  // One sentence saying what to change; the code, when there is some, goes
  // in suggestion — "replace" is GitHub's one-click block, "snippet" is plain
  // code for a fix that doesn't fit the anchored lines.
  fix?: string;
  suggestion?: { kind: 'replace' | 'snippet'; code: string };
  affectedCode: string;
  extraLocations?: CodeLocation[];
  detail?: string;
  mentionId?: number;
}

export interface ExternalReviewOutput {
  findings: ReviewFinding[];
  resolveThreads: Array<{ threadId: string; reason: string }>;
  mentionReplies: Array<{ commentId: number; kind: CommentKind; body: string }>;
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
      "title": "the consequence, not the mechanism, in one sentence (max 90 chars)",
      "origin": { "kind": "new" | "worsened" | "preexisting", "note": "one line: what the PR changed about it (required for worsened and preexisting)" },
      "scenario": {                      // required for bug and decision
        "steps": ["1st concrete step", "2nd", "..."],   // max 5, one action each
        "result": "what happens",
        "expected": "what should have happened"
      },
      "impact": "the only text shown under the title: what to look at and why it matters, in one or two short plain sentences, with no file paths, identifiers or code (max 200 chars)",
      "evidence": [{ "path": "...", "line": 45, "note": "why this line matters (max 100 chars)" }],   // max 3
      "verification": { "status": "reasoned", "reason": "optional, one line" }
                    | { "status": "verified", "test": { "path": "...", "code": "the test", "output": "the failing assertion and its message" } },   // verified only for a test you ran and saw fail
      "fix": "one concrete fix in one sentence, no alternatives",   // optional
      "suggestion": { "kind": "replace", "code": "exact replacement for lines startLine..line" }
                  | { "kind": "snippet", "code": "the key code of a fix that does not fit the anchored lines" },   // optional
      "affectedCode": "the current code at the anchor, a few lines",
      "extraLocations": [{ "path": "...", "line": 7 }],   // optional: other instances of the same mechanism
      "detail": "optional longer explanation (max 1500 chars)",
      "mentionId": 123                   // optional: id of the mention that asked for this
    }
  ],
  "resolveThreads": [{ "threadId": "id of one of your open threads listed above", "reason": "what code change addressed it" }],
  "mentionReplies": [{ "commentId": 123, "kind": "issue" | "review" | "review-body", "body": "your reply" }]
}`;

export const LIMITS = {
  // The prompt asks for 90; this is only a backstop, so a title that runs a
  // few characters over is published whole instead of cut mid-word.
  title: 140,
  category: 40,
  step: 200,
  steps: 5,
  scenarioResult: 200,
  originNote: 200,
  impact: 200,
  note: 100,
  fix: 400,
  affectedCode: 1200,
  suggestion: 2000,
  detail: 1500,
  reason: 300,
  testCode: 3000,
  testOutput: 1500,
  replyBody: 2000,
  evidence: 3,
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

// Cut at the last word boundary when there's one near the limit, so the text
// doesn't end in half a word.
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
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

function parseFinding(raw: unknown, mentionIds: Set<number>, allowVerified: boolean): ReviewFinding {
  if (!isObject(raw)) throw new InvalidField('no es un objeto');
  const type = oneOf(raw.type, TYPES, 'type');
  const line = posInt(raw.line, 'line');
  const startLine = raw.startLine == null ? undefined : posInt(raw.startLine, 'startLine');
  if (startLine != null && startLine > line) throw new InvalidField('startLine posterior a line');

  const scenario = parseScenario(raw.scenario);
  if (type !== 'improvement' && scenario == null) throw new InvalidField(`scenario obligatorio para ${type}`);
  const origin = parseOrigin(raw.origin);

  const finding: ReviewFinding = {
    path: repoPath(raw.path, 'path'),
    line,
    ...(startLine != null ? { startLine } : {}),
    type,
    // A problem the PR found but did not touch is context, not a reason to
    // block it — whatever the agent proposed.
    severity: origin?.kind === 'preexisting' ? 'minor' : oneOf(raw.severity, SEVERITIES, 'severity'),
    category: str(raw.category, 'category', LIMITS.category),
    title: str(raw.title, 'title', LIMITS.title),
    ...(origin != null ? { origin } : {}),
    ...(scenario != null ? { scenario } : {}),
    impact: str(raw.impact, 'impact', LIMITS.impact),
    evidence: locations(raw.evidence, LIMITS.evidence, (e) => ({
      path: repoPath(e.path, 'evidence.path'),
      line: posInt(e.line, 'evidence.line'),
      note: str(e.note, 'evidence.note', LIMITS.note),
    })),
    verification: parseVerification(raw.verification, allowVerified),
    affectedCode: str(raw.affectedCode, 'affectedCode', LIMITS.affectedCode),
  };

  // The previous contract put the fix sentence in a "text" suggestion.
  const legacyFix = isObject(raw.suggestion) && raw.suggestion.kind === 'text' ? raw.suggestion.text : undefined;
  const fix = optStr(raw.fix, LIMITS.fix) ?? optStr(legacyFix, LIMITS.fix);
  if (fix) finding.fix = fix;
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

// Lenient about the shape: a model that still writes the scenario as one
// sentence gets it rendered as the result, not the whole finding dropped.
function parseScenario(raw: unknown): Scenario | undefined {
  const text = optStr(raw, LIMITS.scenarioResult * 2);
  if (text) return { steps: [], result: text };
  if (!isObject(raw)) return undefined;
  const result = optStr(raw.result, LIMITS.scenarioResult);
  if (!result) return undefined;
  const steps = asArray(raw.steps)
    .map((step) => optStr(step, LIMITS.step))
    .filter((step): step is string => step != null)
    .slice(0, LIMITS.steps);
  const expected = optStr(raw.expected, LIMITS.scenarioResult);
  return expected ? { steps, result, expected } : { steps, result };
}

const ORIGINS: readonly FindingOrigin[] = ['new', 'worsened', 'preexisting'];

function parseOrigin(raw: unknown): ReviewFinding['origin'] {
  if (!isObject(raw) || !ORIGINS.includes(raw.kind as FindingOrigin)) return undefined;
  const note = optStr(raw.note, LIMITS.originNote);
  return note ? { kind: raw.kind as FindingOrigin, note } : { kind: raw.kind as FindingOrigin };
}

function parseVerification(raw: unknown, allowVerified: boolean): ReviewFinding['verification'] {
  // A run that was not allowed to execute anything cannot have run a test.
  if (!allowVerified && isObject(raw) && raw.status === 'verified') return { status: 'reasoned' };
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
  if (!isObject(raw) || (raw.kind !== 'replace' && raw.kind !== 'snippet')) return undefined;
  const code = optStr(raw.code, LIMITS.suggestion);
  if (!code) return undefined;
  return raw.kind === 'replace' && line - startLine <= MAX_SUGGESTION_SPAN ? { kind: 'replace', code } : { kind: 'snippet', code };
}

export function parseReviewOutput(
  raw: string,
  ctx: { mentionIds: Set<number>; openThreadIds: Set<string>; allowVerified?: boolean },
): { output: ExternalReviewOutput; dropped: Array<{ index: number; reason: string }> } {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('findings.json no contiene un objeto JSON');

  const dropped: Array<{ index: number; reason: string }> = [];
  const findings: ReviewFinding[] = [];
  asArray(parsed.findings).forEach((rawFinding, index) => {
    try {
      findings.push(parseFinding(rawFinding, ctx.mentionIds, ctx.allowVerified ?? false));
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
      (entry.kind === 'issue' || entry.kind === 'review' || entry.kind === 'review-body') &&
      body
    ) {
      mentionReplies.push({ commentId: entry.commentId, kind: entry.kind, body });
    } else {
      dropped.push({ index: -1, reason: 'mentionReplies: mención ajena o entrada inválida' });
    }
  }

  return { output: { findings, resolveThreads, mentionReplies }, dropped };
}
