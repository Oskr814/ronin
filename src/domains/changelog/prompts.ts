import type { AgentTask, PreparedTask } from '../../core/agent-task.js';
import type { Release } from '../../core/github.js';
import { repoUrl } from '../../core/prompts.js';
import { activeRepo } from '../../core/repo-context.js';
import { ensureChangelogRepoUpToDate } from './changelog.js';

// What the agent is told for each changelog task; core/agent-task.ts runs it.

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
          `You are ronin. ${repoUrl()} just published release "${task.release.name || task.release.tagName}" (tag ${task.release.tagName}, ${task.release.url}).`,
          `This checkout is ${changelogRepo}, already up to date with its own main — add this release to it. Follow this repo's own AGENTS.md and README.md exactly as written (they already describe the full flow: fetching the real release/PR data with \`gh release view\`/\`gh pr view --repo ${activeRepo().productRepo}\`, the frontmatter schema, copy tone, image handling, and validating with \`pnpm build\`) — do not invent your own format or deviate from what those files say.`,
          `Source release data: \`gh release view ${task.release.tagName} --repo ${activeRepo().productRepo} --json body,publishedAt,url\` for the body/timestamp, then \`gh pr view <n> --repo ${activeRepo().productRepo}\` per PR mentioned in it, exactly as AGENTS.md's own workflow section describes.`,
          `Include the screenshots each PR shows — images uploaded to a PR are valid to use as-is, exactly as AGENTS.md's image-handling section describes — except the "before" of an exploration finding: an image whose URL ends in "/antes-<n>.<ext>" (e.g. "antes-1.png?raw=true") shows the problem as it was, not what the release ships, so leave it out.`,
          `Once the entry is written and \`pnpm build\` passes, commit and push straight to main (\`git add -A && git commit && git push origin main\`) — this repo's own AGENTS.md documents that as its normal flow, no PR needed.`,
          'Finally, end your entire response with exactly one line, and nothing after it: "RONIN_STATUS: done".',
        ].join('\n'),
      };
    }
  }
}
