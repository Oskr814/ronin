import { spawn } from 'node:child_process';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';

const MAX_LOG_LINE = 2000;

// `claude -p` prints this as a plain (non-JSON) stdout line and exits 1 when
// the account's spend/usage cap is hit mid-session — a transient, expected
// condition (quota resets on its own) that must never be treated the same
// as a real bug in the agent's work. Callers use this to skip the task
// instead of blocking the issue — see tick.ts.
const USAGE_LIMIT_PATTERN = /usage limit|spend limit/i;

export class ClaudeUsageLimitError extends Error {}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_LOG_LINE ? `${oneLine.slice(0, MAX_LOG_LINE)}… [truncated]` : oneLine;
}

// Renders a tool_use block the way a human skimming the log wants to see
// it — the part of the input that says what's actually being touched,
// not the full JSON args (e.g. a Write's whole file content).
function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `$ ${truncate(String(input.command ?? ''))}`;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return String(input.file_path ?? '');
    case 'Grep':
    case 'Glob':
      return truncate(String(input.pattern ?? ''));
    case 'WebFetch':
    case 'WebSearch':
      return truncate(String(input.url ?? input.query ?? ''));
    default:
      return truncate(JSON.stringify(input));
  }
}

// Parses one `--output-format stream-json` event and logs the parts that
// tell a human what the agent is doing right now — tool calls (with a
// short summary of their input) and the assistant's own text turns.
// Session bookkeeping (system/init, hook events, rate-limit pings) and raw
// tool_result payloads (often full file contents or command output) are
// deliberately not logged — they'd drown out the useful signal; a failed
// tool_result still gets a truncated line so errors aren't invisible.
function logStreamEvent(label: string, event: any): void {
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        log.info(`[${label}] ${truncate(block.text)}`);
      } else if (block.type === 'tool_use') {
        log.info(`[${label}] → ${block.name}: ${summarizeToolUse(block.name, block.input ?? {})}`);
      }
    }
  } else if (event.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_result' && block.is_error) {
        const text = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? '').join(' ')
          : String(block.content ?? '');
        log.error(`[${label}] tool error: ${truncate(text)}`);
      }
    }
  }
}

// Buffers partial chunks into complete lines: stream-json emits one JSON
// object per line, but a `data` event has no relation to line boundaries,
// so a chunk can split (or straddle) a JSON object across two callbacks.
function makeLineBuffer(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

// bypassPermissions is an explicit, deliberate choice (docs/DESIGN.md §7.1),
// not a default — there is nobody to answer a permission prompt in a
// headless run. The worktree is the only containment: this must never be
// called with `cwd` pointing at the main checkout.
//
// GH_TOKEN is forwarded into the child process so that when the spawned
// session itself shells out to `gh` (opening its PR, pushing, editing the
// issue), it authenticates as the `ronin` account too — without this, those
// calls fall back to whatever `gh auth` session is ambient on the host,
// silently defeating the bot-identity work in github.ts.
//
// Streamed line-by-line into the logger (instead of execFile buffering the
// whole run and returning it only at the end) — a task can run up to
// agentTaskTimeoutMs (30min default), and until this the log went dark for
// that entire window with nothing to show it was still alive. stream-json
// (vs the default "text" format) is what makes that streaming show tool
// calls and intermediate reasoning instead of just the final answer.
// The arguments of every headless run; shared with scripts/fix-replay.ts so
// a replay runs on the same model and effort as the real task.
export function claudeHeadlessArgs(prompt: string): string[] {
  return [
    '-p', prompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose',
    ...(config.agentModel ? ['--model', config.agentModel] : []),
    ...(config.agentEffort ? ['--effort', config.agentEffort] : []),
  ];
}

export async function runClaudeHeadless(cwd: string, prompt: string, label: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: config.githubToken };
  // A repos.json entry's own claudeConfigDir wins over the global default —
  // lets each repo run under its own Claude account (docs/superpowers/specs/
  // 2026-08-19-multi-repo-pat-auth-design.md §2).
  const claudeConfigDir = activeRepo().claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.claudeCommand,
      claudeHeadlessArgs(prompt),
      // stdin explicitly closed ('ignore'): an unset stdio here defaults to
      // an open, never-written pipe, which makes `claude -p` wait ~3s for
      // input before warning and proceeding without it on every single run.
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let finalResult = '';
    let stderr = '';
    let timedOut = false;
    let usageLimitHit = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, config.agentTaskTimeoutMs);

    const handleStdoutLine = (line: string) => {
      // Checked against the raw line unconditionally, before parsing: the
      // usage/spend-limit notice isn't always a bare non-JSON line as the
      // stray-output case below assumes — it can also arrive wrapped inside
      // a valid stream-json event (e.g. an assistant text block), in which
      // case JSON.parse succeeds and a check placed only in the catch below
      // would never run.
      if (USAGE_LIMIT_PATTERN.test(line)) usageLimitHit = true;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        log.info(`[${label}] ${line}`); // non-JSON stray output — surface it as-is rather than drop it
        return;
      }
      if (event.type === 'result') finalResult = String(event.result ?? '');
      else logStreamEvent(label, event);
    };
    const handleStderrLine = (line: string) => {
      if (USAGE_LIMIT_PATTERN.test(line)) usageLimitHit = true;
      stderr += `${line}\n`;
      log.info(`[${label}] ${line}`);
    };

    child.stdout.on('data', makeLineBuffer(handleStdoutLine));
    child.stderr.on('data', makeLineBuffer(handleStderrLine));

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(finalResult);
      else if (timedOut) reject(new Error(`${config.claudeCommand} timed out after ${config.agentTaskTimeoutMs}ms`));
      else if (usageLimitHit) reject(new ClaudeUsageLimitError(`${config.claudeCommand} hit its usage/spend limit`));
      else reject(new Error(`${config.claudeCommand} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
