import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAgentTask } from './agent-task.js';
import { postReview, resolveReviewThread, replyToComment, type ReviewThread } from './github.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
import { loadReviewCriteria } from './review-criteria.js';
import { parseReviewOutput, type ReviewFinding } from './review-output.js';
import { commentableLines, placeFindings } from './review-scope.js';
import {
  neutralizeMentions,
  renderClosing,
  renderFindingComment,
  renderReviewSummary,
  type ClosingState,
  type RenderContext,
} from './review-render.js';
import type { ReviewCandidate } from './external-review.js';

// The external review end to end: run the agent, validate the findings.json
// it wrote, place and render every finding, and publish — the agent itself
// never writes to GitHub. Shared by tick.ts and scripts/review-dry-run.ts.
// See docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md.

export interface RunExternalReviewOptions {
  // Render everything into this Markdown file instead of publishing.
  dryRun?: { outFile: string };
}

function outputPathFor(candidate: ReviewCandidate): string {
  // Outside the worktree on purpose: runAgentTask deletes the external
  // review worktree as soon as the agent exits, before this file is read.
  return join(activeRepo().worktreeBasePath, 'external-review-out', `${candidate.prNumber}-${candidate.headSha}.json`);
}

// The title of a thread ronin opened, for the closing message: the first
// "### " heading of its body, without the bold markers.
export function threadTitle(body: string): string {
  const heading = body.split('\n').find((line) => line.startsWith('### '));
  return heading ? heading.slice(4).replace(/\*\*/g, '').trim() : 'Observación abierta';
}

export function closingState(openThreads: ReviewThread[], resolvedIds: Set<string>, prUrl: string): ClosingState {
  const remaining = openThreads.filter((t) => !resolvedIds.has(t.id));
  if (remaining.length > 0) return { open: remaining.map((t) => ({ url: t.url ?? prUrl, title: threadTitle(t.body) })) };
  return resolvedIds.size > 0 ? 'confirmed' : 'lgtm';
}

export async function runExternalReview(candidate: ReviewCandidate, opts: RunExternalReviewOptions = {}): Promise<void> {
  const criteria = await loadReviewCriteria();
  const outputPath = outputPathFor(candidate);
  await mkdir(dirname(outputPath), { recursive: true });
  // A leftover from an earlier failed run must never be mistaken for this
  // run's output.
  await rm(outputPath, { force: true });

  try {
    await runAgentTask({
      type: 'external-review',
      prNumber: candidate.prNumber,
      headRefName: candidate.headRefName,
      headSha: candidate.headSha,
      openThreads: candidate.openThreads,
      mentions: candidate.mentions,
      criteriaText: criteria.text,
      outputPath,
    });

    let raw: string;
    try {
      raw = await readFile(outputPath, 'utf8');
    } catch {
      throw new Error(`external-review no escribió ${outputPath}`);
    }
    const { output, dropped } = parseReviewOutput(raw, {
      mentionIds: new Set(candidate.mentions.map((m) => m.id)),
      openThreadIds: new Set(candidate.openThreads.map((t) => t.id)),
    });
    for (const d of dropped) log.info(`external-review PR #${candidate.prNumber}: descartado (${d.index >= 0 ? `hallazgo ${d.index}` : 'entrada'}): ${d.reason}`);

    const placed = placeFindings(output.findings, await commentableLines(candidate.headSha, candidate.baseRefName));
    const repo = activeRepo().productRepo;
    const ctx: RenderContext = { repo, headSha: candidate.headSha, criteriaHash: criteria.blobHash, mode: 'full' };
    const resolvedIds = new Set(output.resolveThreads.map((r) => r.threadId));
    const prUrl = `https://github.com/${repo}/pull/${candidate.prNumber}`;

    const body = output.findings.length > 0
      ? renderReviewSummary(placed, ctx)
      : renderClosing(closingState(candidate.openThreads, resolvedIds, prUrl));
    const comments = placed.inline.map((f) => ({
      path: f.path,
      line: f.line,
      ...(f.startLine != null ? { startLine: f.startLine } : {}),
      body: renderFindingComment(f, ctx),
    }));
    const replies = output.mentionReplies.map((r) => ({ ...r, body: neutralizeMentions(r.body) }));

    log.metric('external_review_published', {
      prNumber: candidate.prNumber,
      findings: output.findings.length,
      inline: placed.inline.length,
      outOfDiff: placed.outOfDiff.length,
      dropped: dropped.length,
      resolved: resolvedIds.size,
      dryRun: opts.dryRun != null,
    });

    if (opts.dryRun) {
      await writeDryRun(opts.dryRun.outFile, { candidate, body, comments, placed, resolveThreads: output.resolveThreads, replies, dropped });
      return;
    }

    // Resolutions first, so the review that follows already reflects them.
    // One failing mutation is logged and must not stop the review itself.
    for (const r of output.resolveThreads) {
      try {
        await resolveReviewThread(r.threadId);
      } catch (error) {
        log.error(`external-review PR #${candidate.prNumber}: no se pudo resolver el thread ${r.threadId}`, error);
      }
    }
    await postReview(candidate.prNumber, { commitId: candidate.headSha, body, comments });
    for (const reply of replies) {
      await replyToComment(candidate.prNumber, { id: reply.commentId, kind: reply.kind }, reply.body);
    }
  } finally {
    await rm(outputPath, { force: true }).catch(() => {});
  }
}

async function writeDryRun(
  outFile: string,
  data: {
    candidate: ReviewCandidate;
    body: string;
    comments: Array<{ path: string; line: number; startLine?: number; body: string }>;
    placed: { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] };
    resolveThreads: Array<{ threadId: string; reason: string }>;
    replies: Array<{ commentId: number; body: string }>;
    dropped: Array<{ index: number; reason: string }>;
  },
): Promise<void> {
  const sections = [
    `# Dry-run: PR #${data.candidate.prNumber} @ ${data.candidate.headSha.slice(0, 7)}`,
    '',
    `- Hallazgos: ${data.placed.inline.length + data.placed.outOfDiff.length} (${data.placed.inline.length} inline, ${data.placed.outOfDiff.length} fuera del diff)`,
    `- Descartados por validación: ${data.dropped.length}`,
    ...data.dropped.map((d) => `  - ${d.index >= 0 ? `hallazgo ${d.index}` : 'entrada'}: ${d.reason}`),
    `- Threads a resolver: ${data.resolveThreads.length}`,
    ...data.resolveThreads.map((r) => `  - ${r.threadId}: ${r.reason}`),
    '',
    '## Cuerpo de la review',
    '',
    data.body,
    '',
    ...data.comments.flatMap((c) => ['', `## Comentario en \`${c.path}:${c.startLine != null ? `${c.startLine}-` : ''}${c.line}\``, '', c.body]),
    ...data.replies.flatMap((r) => ['', `## Respuesta a la mención ${r.commentId}`, '', r.body]),
  ];
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${sections.join('\n')}\n`);
}
