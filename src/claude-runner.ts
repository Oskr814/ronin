import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

// bypassPermissions is an explicit, deliberate choice (docs/DESIGN.md §7.1),
// not a default — there is nobody to answer a permission prompt in a
// headless run. The worktree is the only containment: this must never be
// called with `cwd` pointing at the main checkout.
export async function runClaudeHeadless(cwd: string, prompt: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--permission-mode', 'bypassPermissions'],
    { cwd, timeout: config.agentTaskTimeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}
