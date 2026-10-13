import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Commits and PR titles ronin writes itself (exploration memory, its PR)
// follow the product repo's own convention, read off its base branch — a
// squash-merged PR title lands on main as a commit like any other. Agents
// get the same rule in their prompts (agent-task.ts's COMMIT_STYLE_RULE).

export type CommitStyle = 'conventional' | 'plain';

const CONVENTIONAL_RE = /^[a-z]+(\([^)]+\))?!?: \S/;
const HISTORY_SIZE = 30;

// Conventional when most of the recent subjects are. Merge commits say
// nothing about the team's style, and a repo with too little history is
// left as plain.
export function styleOf(subjects: string[]): CommitStyle {
  const relevant = subjects.filter((s) => s.trim() && !/^Merge (pull request|branch|remote-tracking)/.test(s));
  if (relevant.length < 5) return 'plain';
  const conventional = relevant.filter((s) => CONVENTIONAL_RE.test(s)).length;
  return conventional * 2 >= relevant.length ? 'conventional' : 'plain';
}

export async function repoCommitStyle(dir: string, ref: string): Promise<CommitStyle> {
  const { stdout } = await execFileAsync('git', ['log', '--format=%s', `-${HISTORY_SIZE}`, ref], { cwd: dir }).catch(() => ({ stdout: '' }));
  return styleOf(stdout.split('\n'));
}

// A subject for something only touching docs: "docs(scope): text" in a
// conventional repo, "Label: text" otherwise.
export function docsSubject(style: CommitStyle, scope: string, label: string, text: string): string {
  return style === 'conventional' ? `docs(${scope}): ${text}` : `${label}: ${text}`;
}
