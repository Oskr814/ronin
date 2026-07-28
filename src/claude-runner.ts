import { spawn } from 'node:child_process';
import { config } from './config.js';
import { getInstallationToken } from './github-app-auth.js';
import { log } from './logger.js';

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
//
// Streamed line-by-line into the logger (instead of execFile buffering the
// whole run and returning it only at the end) — a task can run up to
// agentTaskTimeoutMs (30min default), and until this the log went dark for
// that entire window with nothing to show it was still alive.
export async function runClaudeHeadless(cwd: string, prompt: string, label: string): Promise<string> {
  const token = await getInstallationToken();
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token };
  if (config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.claudeCommand,
      ['-p', prompt, '--permission-mode', 'bypassPermissions'],
      // stdin explicitly closed ('ignore'): an unset stdio here defaults to
      // an open, never-written pipe, which makes `claude -p` wait ~3s for
      // input before warning and proceeding without it on every single run.
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, config.agentTaskTimeoutMs);

    const forwardLines = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) log.info(`[${label}] ${line}`);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; forwardLines(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; forwardLines(chunk); });

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (timedOut) reject(new Error(`${config.claudeCommand} timed out after ${config.agentTaskTimeoutMs}ms`));
      else reject(new Error(`${config.claudeCommand} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
