import { join } from 'node:path';
import { runAgentTask } from '@platform/agents/agent-task.js';
import { commentOnIssue, setReviewStatus, type Comment, type PullRequestStatus } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import { markProcessed } from '@platform/state/processed-comments.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { findUnprocessedMentions } from '../commands/mentions.js';
import { sliceTask } from './prompts.js';
import { publishMockup } from './spec-flow.js';
import { host } from '@platform/host/host.js';


// Talking about a spec on its PR (#241). While the PR of a spec ronin wrote
// (/spec, spec-flow.ts) is open and not started, a mention there gets an
// answer, and the spec gets edited when that's what was asked: one new
// commit on ronin/<issue>/spec. A person approving it is the only signal to
// merge it and start (discoverAssignedSpecs in tick.ts); nothing here
// touches that.
//
// Who can ask: anyone with a real GitHub identity, the same criterion as
// fix-comments-external and thread-reply-external (mentions.ts) — a private
// repo's PR is only visible to people with access to it.

const SPEC_BRANCH_RE = /^ronin\/(\d+)\/spec$/;
export const SPEC_STATUS_CONTEXT = 'ronin/spec';

export interface SpecRevisionCandidate {
  prNumber: number;
  issueNumber: number;
  mentions: Comment[];
}

// The spec PRs among ronin's open PRs, with the issue each came from.
export function openSpecPrs(prs: Pick<PullRequestStatus, 'number' | 'headRefName'>[]): Array<{ prNumber: number; issueNumber: number }> {
  return prs.flatMap((pr) => {
    const match = SPEC_BRANCH_RE.exec(pr.headRefName);
    return match ? [{ prNumber: pr.number, issueNumber: Number(match[1]) }] : [];
  });
}

// Each spec PR with mentions left to answer. findUnprocessedMentions
// answers the meta-commands (help, /preview…) itself and leaves them out.
export async function findSpecRevisionCandidates(prs: PullRequestStatus[], only?: number[]): Promise<SpecRevisionCandidate[]> {
  const candidates: SpecRevisionCandidate[] = [];
  for (const spec of openSpecPrs(prs)) {
    if (only && !only.includes(spec.prNumber)) continue;
    try {
      const mentions = (await findUnprocessedMentions(spec.prNumber)).filter((m) => m.authorLogin !== '');
      if (mentions.length) candidates.push({ ...spec, mentions });
    } catch (error) {
      log.error(`spec PR #${spec.prNumber}: no se pudieron leer las menciones`, error);
    }
  }
  return candidates;
}

// Every mention of one PR in one run. Marked done only after it succeeds:
// one that fails is retried on the next tick, like the other flows.
export async function processSpecRevision(candidate: SpecRevisionCandidate): Promise<void> {
  const { prNumber, issueNumber } = candidate;
  const outDir = join(activeRepo().worktreeBasePath, 'spec-out', `${issueNumber}-revise`);
  try {
    await host().fs.rm(outDir, { recursive: true, force: true });
    await host().fs.mkdir(outDir, { recursive: true });
    await setReviewStatus(prNumber, 'pending', 'ronin está leyendo los comentarios del spec…', { context: SPEC_STATUS_CONTEXT });
    await runAgentTask(sliceTask({ type: 'revise-spec', issueNumber, prNumber, mentions: candidate.mentions, outDir }));
    const mockup = join(outDir, 'mockup.html');
    if (await host().fs.exists(mockup)) {
      const url = await publishMockup(issueNumber, mockup, outDir).catch((error: unknown) => {
        log.error(`spec PR #${prNumber}: no se pudo publicar el mockup`, error);
        return undefined;
      });
      if (url) await commentOnIssue(prNumber, `Mockup actualizado:\n\n<img src="${url}" alt="Mockup del spec" width="720">`);
    }
    await setReviewStatus(prNumber, 'success', 'Comentarios del spec atendidos', { context: SPEC_STATUS_CONTEXT });
    for (const m of candidate.mentions) await markProcessed(m);
  } catch (error) {
    await setReviewStatus(prNumber, 'error', 'No se pudo atender el comentario: ver el log', { context: SPEC_STATUS_CONTEXT });
    log.error(`revise-spec falló para el PR #${prNumber}`, error);
  }
}
