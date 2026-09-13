import { listOpenUnmanagedIssues, type Comment } from './github.js';
import { findTrustedSpikeCommand, parseSpikeCommand } from './mentions.js';
import { log } from './logger.js';

export interface SpikeCandidate {
  issueNumber: number;
  appName: string;
  instruction?: string;
  trigger: Comment[];
}

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as external-review.ts and mentions.ts.
export async function findIssuesNeedingSpike(): Promise<SpikeCandidate[]> {
  const issues = await listOpenUnmanagedIssues();
  const candidates: SpikeCandidate[] = [];
  for (const issue of issues) {
    // Per-issue isolation: one flaky comment-listing call or malformed
    // comment must not throw out of the whole loop and zero out /spike for
    // every other candidate this tick — same reasoning as
    // findPrsNeedingReview's own per-PR try/catch.
    try {
      const trigger = await findTrustedSpikeCommand(issue.number);
      if (trigger.length === 0) continue;
      // Uses the first unprocessed command's params — the common case is
      // exactly one. A malformed command (missing app_name) has nothing
      // actionable to build a candidate from, so it's skipped rather than
      // escalated: /spike is advisory, not a task a human is waiting on the
      // way an assigned issue is.
      const parsed = parseSpikeCommand(trigger[0].body);
      if (!parsed) continue;
      candidates.push({ issueNumber: issue.number, appName: parsed.appName, instruction: parsed.instruction, trigger });
    } catch (error) {
      log.error(`findIssuesNeedingSpike: issue #${issue.number} falló al evaluar, se salta este tick`, error);
    }
  }
  return candidates;
}
