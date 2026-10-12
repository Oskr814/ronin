import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAgentTask } from './agent-task.js';
import { postReview, resolveReviewThread, replyToComment, type ReviewThread } from './github.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
import { loadReviewCriteria } from './review-criteria.js';
import { parseReviewOutput, type ReviewFinding } from './review-output.js';
import {
  applyScopeRules,
  changedLinesSince,
  commentableLines,
  dedupeAgainstOpenThreads,
  diffContext,
  formatChangedLines,
  isOnChangedCode,
  placeFindings,
  type ReviewMode,
} from './review-scope.js';
import { pinReviewedSha } from './worktree.js';
import {
  neutralizeMentions,
  renderClosing,
  renderFindingComment,
  renderReviewSummary,
  reviewMarker,
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
  const start = Date.now();
  const criteria = await loadReviewCriteria();
  const outputPath = outputPathFor(candidate);
  const agentsPath = outputPath.replace(/\.json$/, '.agents.json');
  await mkdir(dirname(outputPath), { recursive: true });
  // A leftover from an earlier failed run must never be mistaken for this
  // run's output.
  await rm(outputPath, { force: true });

  try {
    // Incremental against the last reviewed SHA when there is one: the
    // changed lines go into the prompt, and the scope rules below use them.
    // diffContext fetches the PR head and the base: it goes first so every
    // other git call on headSha finds it.
    const diff = await diffContext(candidate.prNumber, candidate.headSha, candidate.baseRefName);
    const scope: ReviewMode = candidate.previousSha
      ? { mode: 'incremental', changed: await changedLinesSince(candidate.previousSha, candidate.headSha, candidate.baseRefName) }
      : { mode: 'full' };

    const agentStart = Date.now();
    await runAgentTask({
      type: 'external-review',
      prNumber: candidate.prNumber,
      headRefName: candidate.headRefName,
      headSha: candidate.headSha,
      baseRefName: candidate.baseRefName,
      threadHistory: candidate.threadHistory,
      mentions: candidate.mentions,
      canExecute: candidate.canExecute,
      criteria,
      diff,
      outputPath,
      agentsPath,
      scope:
        scope.mode === 'incremental'
          ? { mode: 'incremental', previousSha: candidate.previousSha!, changedLines: formatChangedLines(scope.changed) }
          : { mode: 'full' },
    });

    const agentMs = Date.now() - agentStart;

    let raw: string;
    try {
      raw = await readFile(outputPath, 'utf8');
    } catch {
      throw new Error(`external-review no escribió ${outputPath}`);
    }
    const { output, dropped } = parseReviewOutput(raw, {
      mentionIds: new Set(candidate.mentions.map((m) => m.id)),
      openThreadIds: new Set(candidate.openThreads.map((t) => t.id)),
      allowVerified: candidate.canExecute,
    });
    for (const d of dropped) log.info(`external-review PR #${candidate.prNumber}: descartado (${d.index >= 0 ? `hallazgo ${d.index}` : 'entrada'}): ${d.reason}`);

    // The scope rules and the dedupe are enforced here, whatever the agent
    // did with the same instructions in its prompt.
    const scoped = applyScopeRules(output.findings, scope);
    const deduped = dedupeAgainstOpenThreads(scoped.kept, candidate.threadHistory);
    for (const d of scoped.dropped) log.info(`external-review PR #${candidate.prNumber}: descartado por alcance (${d.reason}): ${d.finding.title}`);
    for (const d of deduped.dropped) log.info(`external-review PR #${candidate.prNumber}: descartado, repite el thread ${d.threadId}: ${d.finding.title}`);
    const findings = deduped.kept;

    const placed = placeFindings(findings, await commentableLines(candidate.headSha, candidate.baseRefName));
    const repo = activeRepo().productRepo;
    const ctx: RenderContext = {
      repo,
      headSha: candidate.headSha,
      criteriaHash: criteria.blobHash,
      mode: scope.mode,
      ...(scope.mode === 'incremental' ? { scopeOf: (f: ReviewFinding) => (isOnChangedCode(f, scope.changed) ? 'changed' : 'reviewed') } : {}),
    };
    const resolvedIds = new Set(output.resolveThreads.map((r) => r.threadId));
    const prUrl = `https://github.com/${repo}/pull/${candidate.prNumber}`;

    const body = [
      reviewMarker(ctx),
      findings.length > 0 ? renderReviewSummary(placed, ctx) : renderClosing(closingState(candidate.openThreads, resolvedIds, prUrl)),
    ].join('\n');
    const comments = placed.inline.map((f) => ({
      path: f.path,
      line: f.line,
      ...(f.startLine != null ? { startLine: f.startLine } : {}),
      body: renderFindingComment(f, ctx),
    }));
    const replies = output.mentionReplies.map((r) => ({ ...r, body: neutralizeMentions(r.body) }));

    log.metric('external_review_published', {
      prNumber: candidate.prNumber,
      mode: scope.mode,
      findings: findings.length,
      inline: placed.inline.length,
      outOfDiff: placed.outOfDiff.length,
      dropped: dropped.length,
      droppedByScope: scoped.dropped.length,
      droppedAsDuplicate: deduped.dropped.length,
      resolved: resolvedIds.size,
      dryRun: opts.dryRun != null,
      // Where the time went: preparing (git, criteria) vs. the agent run vs.
      // validating and rendering up to here. Publishing is not included.
      prepMs: agentStart - start,
      agentMs,
      postAgentMs: Date.now() - agentStart - agentMs,
    });

    if (opts.dryRun) {
      await writeDryRun(opts.dryRun.outFile, {
        candidate,
        scope,
        body,
        comments,
        placed,
        resolveThreads: output.resolveThreads,
        replies,
        dropped,
        droppedByScope: [
          ...scoped.dropped.map((d) => `${d.finding.title} — ${d.reason}`),
          ...deduped.dropped.map((d) => `${d.finding.title} — repite el thread ${d.threadId}`),
        ],
      });
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
    // Keeps the reviewed commit around for the next incremental review; the
    // review is already published, so a failure here only costs that.
    await pinReviewedSha(candidate.prNumber, candidate.headSha).catch((error) =>
      log.error(`external-review PR #${candidate.prNumber}: no se pudo fijar el SHA revisado`, error),
    );
  } finally {
    await rm(outputPath, { force: true }).catch(() => {});
  }
}

async function writeDryRun(
  outFile: string,
  data: {
    candidate: ReviewCandidate;
    scope: ReviewMode;
    body: string;
    comments: Array<{ path: string; line: number; startLine?: number; body: string }>;
    placed: { inline: ReviewFinding[]; outOfDiff: ReviewFinding[] };
    resolveThreads: Array<{ threadId: string; reason: string }>;
    replies: Array<{ commentId: number; body: string }>;
    dropped: Array<{ index: number; reason: string }>;
    droppedByScope: string[];
  },
): Promise<void> {
  const sections = [
    `# Dry-run: PR #${data.candidate.prNumber} @ ${data.candidate.headSha.slice(0, 7)}`,
    '',
    data.scope.mode === 'incremental'
      ? `- Modo: incremental desde \`${data.candidate.previousSha?.slice(0, 7)}\` (${[...data.scope.changed.values()].reduce((n, l) => n + l.size, 0)} líneas cambiadas en ${data.scope.changed.size} archivos)`
      : '- Modo: completo',
    `- Hallazgos: ${data.placed.inline.length + data.placed.outOfDiff.length} (${data.placed.inline.length} inline, ${data.placed.outOfDiff.length} fuera del diff)`,
    `- Descartados por validación: ${data.dropped.length}`,
    ...data.dropped.map((d) => `  - ${d.index >= 0 ? `hallazgo ${d.index}` : 'entrada'}: ${d.reason}`),
    `- Descartados por alcance o por repetir un thread: ${data.droppedByScope.length}`,
    ...data.droppedByScope.map((d) => `  - ${d}`),
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
