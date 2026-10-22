import type { AgentTask, PreparedTask } from '@platform/agents/agent-task.js';
import type { Release } from '@platform/github/github.js';
import { repoUrl } from '@platform/agents/prompts.js';
import { activeRepo } from '@platform/agents/repo-context.js';
import { ensureChangelogRepoUpToDate } from './changelog.js';

// What the agent is told for each changelog task; platform/agents/agent-task.ts runs it.

export type ChangelogTask =
  | { type: 'update-changelog'; release: Release };

export function changelogTask(task: ChangelogTask): AgentTask & ChangelogTask {
  return { ...task, prepare: () => buildChangelogTask(task) };
}

async function buildChangelogTask(task: ChangelogTask): Promise<PreparedTask> {
  switch (task.type) {
    case 'update-changelog': {
      const changelogRepo = activeRepo().changelogRepo;
      return {
        // Not a branch to check out — this task type works directly on
        // changelogRepoPath's main via ensureChangelogRepoUpToDate below.
        // This value exists purely for the log line.
        branch: `changelog@${task.release.tagName}`,
        checkout: { kind: 'dir', dir: ensureChangelogRepoUpToDate },
        label: `release ${task.release.tagName}`,
        tag: task.release.tagName,
        prompt: [
          `Usa la skill ronin:update-changelog. Eres ronin: ${repoUrl()} acaba de publicar la release "${task.release.name || task.release.tagName}" (tag ${task.release.tagName}, ${task.release.url}).`,
          `El repo de producto: ${activeRepo().productRepo}. Este checkout es ${changelogRepo}, al día con su main.`,
          // The tick reads it from the run's last line.
          'Termina tu respuesta con exactamente una línea, y nada después: "RONIN_STATUS: done".',
        ].join('\n\n'),
      };
    }
  }
}
