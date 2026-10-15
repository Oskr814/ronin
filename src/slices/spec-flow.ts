import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentTask } from '../core/agent-task.js';
import { activeRepo } from '../core/repo-context.js';
import { log } from '../core/logger.js';
import { addReaction, commentOnIssue, findOpenPrByHead, replyToComment } from '../core/github.js';
import { renderHtmlToPng } from '../app/index.js';
import { evidenceUrl, publishEvidence } from '../app/index.js';
import { startInterview } from './interview.js';
import { specBranch } from './stack.js';
import type { SpecCandidate } from '../commands/index.js';

// /spec — docs/DESIGN.md §11.10, stage 5: from a raw request (or an
// exploration proposal) to a draft spec PR assigned to ronin. The human
// edits it there and marks it ready when it should start: from then on it
// is an ordinary spec PR (discoverAssignedSpecs in tick.ts). If the agent
// lacks something essential it asks on the issue, and a Remote Control
// interview offers a faster way to answer; once answered, the /spec runs
// again on its own (interview.ts's "spec" resume).

export function specNeedsInfo(result: string): boolean {
  return /RONIN_STATUS:\s*needs-info/i.test(result);
}

// The mockup the agent drew, as a PNG in the evidence branch (the same one
// the exploration's screenshots go to), so the spec PR can show it.
async function publishMockup(issueNumber: number, htmlPath: string, outDir: string): Promise<string> {
  const png = join(outDir, 'mockup.png');
  await renderHtmlToPng(htmlPath, png, { width: 1440, height: 900 });
  const path = `specs/${issueNumber}/mockup-${Date.now()}.png`;
  const sha = await publishEvidence(activeRepo().productRepoPath, [{ src: png, path }], `mockup del spec #${issueNumber}`);
  return evidenceUrl(sha, path);
}

export async function processSpecCandidate(candidate: SpecCandidate): Promise<void> {
  const outDir = join(activeRepo().worktreeBasePath, 'spec-out', String(candidate.issueNumber));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  try {
    const result = await runAgentTask({
      type: 'write-spec',
      issueNumber: candidate.issueNumber,
      appName: candidate.appName,
      ...(candidate.instruction ? { instruction: candidate.instruction } : {}),
      trigger: candidate.trigger,
      outDir,
    });
    const issueUrl = `https://github.com/${activeRepo().productRepo}/issues/${candidate.issueNumber}`;
    if (specNeedsInfo(result)) {
      await startInterview(candidate.issueNumber, issueUrl, { kind: 'spec', appName: candidate.appName, ...(candidate.instruction ? { instruction: candidate.instruction } : {}) })
        .catch((error) => log.error(`spec #${candidate.issueNumber}: no se pudo abrir la entrevista`, error));
      return;
    }
    const mockup = join(outDir, 'mockup.html');
    const pr = await findOpenPrByHead(specBranch(candidate.issueNumber));
    if (pr && existsSync(mockup)) {
      const url = await publishMockup(candidate.issueNumber, mockup, outDir).catch((error: unknown) => {
        log.error(`spec #${candidate.issueNumber}: no se pudo publicar el mockup`, error);
        return undefined;
      });
      if (url) await commentOnIssue(pr.number, `Mockup de la propuesta:\n\n<img src="${url}" alt="Mockup del spec" width="720">`);
    }
  } catch (error) {
    log.error(`spec falló para issue #${candidate.issueNumber}`, error);
    const first = candidate.trigger[0];
    if (first) {
      await replyToComment(candidate.issueNumber, first, `No pude escribir el spec: ${(error as Error).message.split('\n')[0].slice(0, 300)}. El detalle está en el log del runner.`).catch(() => {});
    }
  } finally {
    // Reacted to on success and failure alike: a /spec that fails is
    // answered, not retried every tick at the cost of another agent run.
    for (const m of candidate.trigger) await addReaction(m.id, m.kind, 'eyes').catch(() => {});
  }
}
