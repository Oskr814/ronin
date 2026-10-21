import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeRepo } from '../../core/repo-context.js';
import { config } from '../../core/config.js';

const execFileAsync = promisify(execFile);

// A repos.json entry's own worktreeBaseRef wins over the global default —
// same override pattern as claudeConfigDir (see repo-context.ts). Needed
// because not every product repo's default/active branch is named "main"
// (e.g. a repo migrated to "odoo-main" while "main" stays around, stale).
function baseRef(): string {
  return activeRepo().worktreeBaseRef ?? config.worktreeBaseRef;
}

// Updates the local remote-tracking ref for the active repo's base branch
// only — never touches the primary checkout's working directory or index,
// so it's safe to call regardless of what branch a human has checked out
// there.
export async function fetchOriginMain(): Promise<void> {
  const branch = baseRef().replace(/^origin\//, '');
  await execFileAsync('git', ['fetch', 'origin', branch], { cwd: activeRepo().productRepoPath });
}

// Reads a file's content as of the active repo's base branch via `git
// show`, not the filesystem — same reasoning as fetchOriginMain: no
// dependency on what's currently checked out. Caller must have fetched
// recently enough.
export async function readSpecFile(specPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', `${baseRef()}:${specPath}`], { cwd: activeRepo().productRepoPath });
  return stdout;
}

export function extractTitle(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1] ?? fallback;
}
