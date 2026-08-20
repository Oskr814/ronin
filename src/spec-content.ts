import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeRepo } from './repo-context.js';

const execFileAsync = promisify(execFile);

// Updates the local origin/main remote-tracking ref only — never touches
// the primary checkout's working directory or index, so it's safe to call
// regardless of what branch a human has checked out there.
export async function fetchOriginMain(): Promise<void> {
  await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: activeRepo().productRepoPath });
}

// Reads a file's content as of origin/main via `git show`, not the
// filesystem — same reasoning as fetchOriginMain: no dependency on what's
// currently checked out. Caller must have fetched recently enough.
export async function readSpecFile(specPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', `origin/main:${specPath}`], { cwd: activeRepo().productRepoPath });
  return stdout;
}

export function extractTitle(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1] ?? fallback;
}
