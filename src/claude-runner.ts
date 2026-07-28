import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { getInstallationToken } from './github-app-auth.js';

const execFileAsync = promisify(execFile);

// bypassPermissions is an explicit, deliberate choice (docs/DESIGN.md §7.1),
// not a default — there is nobody to answer a permission prompt in a
// headless run. The worktree is the only containment: this must never be
// called with `cwd` pointing at the main checkout.
//
// GH_TOKEN is forwarded into the child process so that when the spawned
// session itself shells out to `gh` (opening its PR, pushing, editing the
// issue), it authenticates as ValerIA[bot] too — without this, those calls
// fall back to whatever `gh auth` session is ambient on the host, silently
// defeating the bot-identity work in github.ts.
export async function runClaudeHeadless(cwd: string, prompt: string): Promise<string> {
  const token = await getInstallationToken();
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--permission-mode', 'bypassPermissions'],
    { cwd, timeout: config.agentTaskTimeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_TOKEN: token } },
  );
  return stdout;
}
