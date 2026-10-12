import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';

const execFileAsync = promisify(execFile);

// Background Claude sessions (`claude --bg`), for what `claude -p` can't do:
// be reachable over Remote Control (interview.ts). Checked in the 2026-10-11 spike: the session is
// started with its prompt, `claude logs <id>` shows its screen, `claude
// agents --json` its state, and `claude stop` + `claude rm` remove it.
//
// Sessions run from ronin's own checkout: without a TTY Claude can't ask to
// trust a directory, so it has to be one already trusted.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g;
const BG_ID_RE = /backgrounded\s*·\s*([0-9a-f]{6,})/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function parseBackgroundId(stdout: string): string | undefined {
  return stripAnsi(stdout).match(BG_ID_RE)?.[1];
}

function claudeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const claudeConfigDir = activeRepo().claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

async function claude(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync(config.claudeCommand, args, { env: claudeEnv(extraEnv), cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface BackgroundSessionOptions {
  name: string;
  prompt: string;
  permissionMode: string;
  model?: string;
  // Starts it with Remote Control on, under this name.
  remoteControl?: boolean;
  allowedTools?: string[];
  addDirs?: string[];
  env?: Record<string, string>;
}

export async function startBackgroundSession(opts: BackgroundSessionOptions): Promise<string> {
  const args = [
    '--bg',
    '-n', opts.name,
    ...(opts.remoteControl ? ['--remote-control', opts.name] : []),
    '--permission-mode', opts.permissionMode,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.allowedTools?.length ? ['--allowedTools', ...opts.allowedTools] : []),
    ...(opts.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
    '--',
    opts.prompt,
  ];
  const stdout = await claude(args, opts.env);
  const id = parseBackgroundId(stdout);
  if (!id) throw new Error(`no pude leer el id de la sesión en background: ${stdout.slice(0, 300)}`);
  return id;
}

export async function sessionLogs(id: string): Promise<string> {
  return stripAnsi(await claude(['logs', id]).catch(() => ''));
}

// The session as `claude agents --json` lists it, or null once it's gone.
// A session that answered and waits for more input shows status "idle" and
// state "done" — the same as one that is truly finished, so callers that
// wait for a person (interview.ts) can't use this as "finished".
export async function sessionState(id: string): Promise<{ status?: string; state?: string } | null> {
  const sessions = JSON.parse(await claude(['agents', '--json'])) as Array<{ id?: string; status?: string; state?: string }>;
  return sessions.find((s) => s.id === id) ?? null;
}

export async function removeSession(id: string): Promise<void> {
  await claude(['stop', id]).catch(() => {});
  await claude(['rm', id]).catch(() => {});
}
