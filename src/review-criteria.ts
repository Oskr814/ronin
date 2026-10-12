import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Lives in ronin's own checkout, never in the product repo: the external
// review worktree is the head of an untrusted PR, and a PR must not be able to
// rewrite the criteria it is reviewed against. Read on every run (same pattern
// as templates/tracking-issue.md in tick.ts), so tuning it needs no rebuild —
// see docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md.
export const REVIEW_CRITERIA_PATH = 'prompts/external-review-criteria.md';
// One file per specialized review worker: its dimension's checklist, how to
// walk the diff and real examples. Passed to `claude -p --agents`, so each
// worker's instructions reach it verbatim instead of through the
// orchestrator's paraphrase.
export const REVIEW_AGENTS_DIR = 'prompts/review-agents';

export interface ReviewAgentSpec {
  // The file name without .md — also the subagent_type the orchestrator uses.
  name: string;
  description: string;
  // Only launched in an incremental review (the delta worker).
  incrementalOnly: boolean;
  body: string;
}

export interface ReviewCriteria {
  // What every worker shares: types, origin, severity, systemic classes and
  // "No marcar".
  common: string;
  agents: ReviewAgentSpec[];
  // The common criteria plus every dimension's checklist — for whoever judges
  // findings across all dimensions (the orchestrator, the fix self-review).
  text: string;
  blobHash: string;
}

// Same hash `git hash-object` computes. Taken over the criteria file followed
// by every agent file in name order, so
// `cat prompts/external-review-criteria.md prompts/review-agents/*.md | git hash-object --stdin`
// reproduces the hash the ronin:finding marker records. Hashed over the raw
// bytes: the blob header carries the byte length, which differs from the
// character length for non-ASCII text.
function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

export function parseAgentFile(name: string, content: string): ReviewAgentSpec {
  const match = FRONTMATTER.exec(content);
  const fields = new Map<string, string>();
  for (const line of match?.[1].split('\n') ?? []) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const description = fields.get('description');
  if (!description) throw new Error(`${REVIEW_AGENTS_DIR}/${name}.md: falta "description" en el frontmatter`);
  return {
    name,
    description,
    incrementalOnly: fields.get('when') === 'incremental',
    body: content.slice(match?.[0].length ?? 0).trim(),
  };
}

// Each agent file's headings start at "#"; nested under "### Agente <name>"
// they move down three levels.
function nestHeadings(body: string): string {
  return body.replace(/^(#+) /gm, '###$1 ');
}

export async function loadReviewCriteria(): Promise<ReviewCriteria> {
  const root = process.cwd();
  const criteria = await readFile(join(root, REVIEW_CRITERIA_PATH));
  const names = (await readdir(join(root, REVIEW_AGENTS_DIR))).filter((f) => f.endsWith('.md')).sort();
  if (names.length === 0) throw new Error(`${REVIEW_AGENTS_DIR} no tiene agentes`);
  const agentFiles = await Promise.all(names.map((f) => readFile(join(root, REVIEW_AGENTS_DIR, f))));
  const agents = names.map((f, i) => parseAgentFile(f.slice(0, -3), agentFiles[i].toString('utf8')));

  const common = criteria.toString('utf8').trim();
  const text = [
    common,
    '## Detalle por dimensión',
    ...agents.map((a) => `### Agente \`${a.name}\`\n\n${nestHeadings(a.body)}`),
  ].join('\n\n');
  return { common, agents, text, blobHash: gitBlobHash(Buffer.concat([criteria, ...agentFiles])) };
}
