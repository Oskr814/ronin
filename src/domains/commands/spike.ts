import { listOpenUnmanagedIssues, type Comment } from '@platform/github/github.js';
import { findTrustedIssueCommands, parseExploreCommand, parseSpecCommand, parseSpikeCommand } from './mentions.js';
import { log } from '@platform/logger.js';

export interface SpikeCandidate {
  issueNumber: number;
  appName: string;
  instruction?: string;
  trigger: Comment[];
}

export interface SpecCandidate {
  issueNumber: number;
  appName: string;
  instruction?: string;
  trigger: Comment[];
}

export interface ExploreCandidate {
  issueNumber: number;
  appName: string;
  maxFunctions?: number;
  trigger: Comment[];
}

export interface IssueCommandCandidates {
  spikes: SpikeCandidate[];
  explores: ExploreCandidate[];
  specs: SpecCandidate[];
}

// Separate module from tick.ts (orchestrator) and github.ts (low-level `gh`
// layer) — same split as domains/review/external.ts and mentions.ts.
export async function findIssuesNeedingSpike(): Promise<SpikeCandidate[]> {
  return (await findIssueCommands()).spikes;
}

// /spike, /explore and /spec, found in one
// pass over the open unmanaged issues.
// `only` narrows it to those issues, like findPrsNeedingReview's.
export async function findIssueCommands(only?: number[]): Promise<IssueCommandCandidates> {
  const open = await listOpenUnmanagedIssues();
  const issues = only ? open.filter((issue) => only.includes(issue.number)) : open;
  const spikes: SpikeCandidate[] = [];
  const explores: ExploreCandidate[] = [];
  const specs: SpecCandidate[] = [];
  for (const issue of issues) {
    // Per-issue isolation: one flaky comment-listing call or malformed
    // comment must not throw out of the whole loop and zero out /spike for
    // every other candidate this tick — same reasoning as
    // findPrsNeedingReview's own per-PR try/catch.
    try {
      const { spike, explore, spec } = await findTrustedIssueCommands(issue.number);
      // Uses the first unprocessed command's params — the common case is
      // exactly one. A malformed command (missing app_name) has nothing
      // actionable to build a candidate from, so it's skipped rather than
      // escalated: /spike is advisory, not a task a human is waiting on the
      // way an assigned issue is.
      const parsedSpike = spike.length > 0 ? parseSpikeCommand(spike[0].body) : null;
      if (parsedSpike) spikes.push({ issueNumber: issue.number, appName: parsedSpike.appName, instruction: parsedSpike.instruction, trigger: spike });
      const parsedExplore = explore.length > 0 ? parseExploreCommand(explore[0].body) : null;
      if (parsedExplore) explores.push({ issueNumber: issue.number, ...parsedExplore, trigger: explore });
      const parsedSpec = spec.length > 0 ? parseSpecCommand(spec[0].body) : null;
      if (parsedSpec) specs.push({ issueNumber: issue.number, appName: parsedSpec.appName, instruction: parsedSpec.instruction, trigger: spec });
    } catch (error) {
      log.error(`findIssueCommands: issue #${issue.number} falló al evaluar, se salta este tick`, error);
    }
  }
  return { spikes, explores, specs };
}
