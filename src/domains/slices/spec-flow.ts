import { markProcessed } from '@platform/state/processed-comments.js';
import { join } from 'node:path';
import { runAgentTask } from '@platform/agents/agent-task.js';
import { sliceTask } from './prompts.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { log } from '@platform/logger.js';
import { commentOnIssue, findOpenPrByHead, replyToComment } from '@platform/github/github.js';
import { renderHtmlToPng } from '../product-app/index.js';
import { evidenceUrl, publishEvidence } from '../product-app/index.js';
import { notifyBlocker } from '@platform/notify/notifier.js';
import { specBranch } from './stack.js';
import type { SpecCandidate } from '../commands/index.js';
import { host } from '@platform/host/host.js';

// /spec — docs/DESIGN.md §11.10, stage 5: from a raw request (or an
// exploration proposal) to a draft spec PR assigned to ronin. The human
// edits it there and marks it ready when it should start: from then on it
// is an ordinary spec PR (discoverAssignedSpecs in tick.ts). If the agent
// lacks something essential it asks on the issue and the team gets an
// email; once it's answered there, someone asks for the /spec again.

export function specNeedsInfo(result: string): boolean {
  return /RONIN_STATUS:\s*needs-info/i.test(result);
}

// The mockup the agent drew, as a PNG in the evidence branch (the same one
// the exploration's screenshots go to), so the spec PR can show it.
export async function publishMockup(issueNumber: number, htmlPath: string, outDir: string): Promise<string> {
  const png = join(outDir, 'mockup.png');
  await renderHtmlToPng(htmlPath, png, { width: 1440, height: 900 });
  const path = `specs/${issueNumber}/mockup-${Date.now()}.png`;
  const sha = await publishEvidence(activeRepo().productRepoPath, [{ src: png, path }], `mockup del spec #${issueNumber}`);
  return evidenceUrl(sha, path);
}

export async function processSpecCandidate(candidate: SpecCandidate): Promise<void> {
  const outDir = join(activeRepo().worktreeBasePath, 'spec-out', String(candidate.issueNumber));
  await host().fs.rm(outDir, { recursive: true, force: true });
  await host().fs.mkdir(outDir, { recursive: true });
  try {
    const result = await runAgentTask(sliceTask({
      type: 'write-spec',
      issueNumber: candidate.issueNumber,
      appName: candidate.appName,
      ...(candidate.instruction ? { instruction: candidate.instruction } : {}),
      trigger: candidate.trigger,
      outDir,
    }));
    const issueUrl = `https://github.com/${activeRepo().productRepo}/issues/${candidate.issueNumber}`;
    if (specNeedsInfo(result)) {
      await notifyBlocker({ issueUrl, reason: 'ronin necesita información para escribir el spec', excerpt: 'Las preguntas están en el issue: respóndelas ahí y vuelve a pedir el /spec.' });
      return;
    }
    const mockup = join(outDir, 'mockup.html');
    const pr = await findOpenPrByHead(specBranch(candidate.issueNumber));
    if (pr && (await host().fs.exists(mockup))) {
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
    for (const m of candidate.trigger) await markProcessed(m).catch(() => {});
  }
}
