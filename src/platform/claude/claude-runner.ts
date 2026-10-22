import { spawn } from 'node:child_process';
import { config, defaultAgentModel, defaultAgentEffort } from '../config/config.js';
import { activeRepo } from '../agents/repo-context.js';
import { log } from '../logger.js';
import { recordRateLimit, recordUsageLimitHit } from './claude-usage.js';
import type { RunResult, RunSink, RunStep } from '../agents/run-record.js';
import { lendClaudeAccount, type AgentUser } from '../agents/agent-user.js';

const MAX_LOG_LINE = 2000;

// `claude -p` prints this as a plain (non-JSON) stdout line and exits 1 when
// the account's spend/usage cap is hit mid-session — a transient, expected
// condition (quota resets on its own) that must never be treated the same
// as a real bug in the agent's work. Callers use this to skip the task
// instead of blocking the issue — see tick.ts.
const USAGE_LIMIT_PATTERN = /usage limit|spend limit/i;

export class ClaudeUsageLimitError extends Error {}

// The run went past agentTaskTimeoutMs and was killed. Its own class so the
// run record can tell a timeout from any other failure (run-record.ts).
export class ClaudeTimeoutError extends Error {}

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
    case 'Task':
    case 'Agent':
      return truncate(String(input.description ?? input.subagent_type ?? ''));
    case 'WebFetch':
    case 'WebSearch':
      return truncate(String(input.url ?? input.query ?? ''));
    default:
      return truncate(JSON.stringify(input));
  }
}

// Parses one `--output-format stream-json` event into the parts that tell a
// human what the agent is doing right now — tool calls (with a short summary
// of their input) and the assistant's own text turns. Session bookkeeping
// (system/init, hook events, rate-limit pings) and raw tool_result payloads
// (often full file contents or command output) are deliberately left out —
// they'd drown out the useful signal; a failed tool_result still gets a
// truncated step so errors aren't invisible.
export function streamSteps(event: any): RunStep[] {
  const steps: RunStep[] = [];
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        steps.push({ kind: 'text', text: truncate(block.text) });
      } else if (block.type === 'tool_use') {
        steps.push({ kind: 'tool', name: block.name, summary: summarizeToolUse(block.name, block.input ?? {}) });
      }
    }
  } else if (event.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_result' && block.is_error) {
        const text = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? '').join(' ')
          : String(block.content ?? '');
        steps.push({ kind: 'tool_error', text: truncate(text) });
      }
    }
  }
  return steps;
}

function logStep(label: string, step: RunStep): void {
  if (step.kind === 'text') log.info(`[${label}] ${step.text}`);
  else if (step.kind === 'tool') log.info(`[${label}] → ${step.name}: ${step.summary}`);
  else log.error(`[${label}] tool error: ${step.text}`);
}

// The run's totals, from its final `result` event.
export function resultStats(event: any): RunResult {
  const usage = event.usage ?? {};
  const stats: RunResult = {};
  if (typeof event.session_id === 'string') stats.sessionId = event.session_id;
  if (typeof event.total_cost_usd === 'number') stats.costUsd = event.total_cost_usd;
  if (typeof event.num_turns === 'number') stats.numTurns = event.num_turns;
  if (typeof usage.input_tokens === 'number') stats.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') stats.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') stats.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') stats.cacheCreationTokens = usage.cache_creation_input_tokens;
  return stats;
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
// What a single run may set on top of the defaults: the model and effort of
// its task type (config.ts's agentModelFor/agentEffortFor), a file with
// the subagents it may launch (`--agents`, the external review's workers),
// and the MCP servers it gets (`--mcp-config`, exploration's browsers) — only
// those: --strict-mcp-config, on every run, keeps out whatever MCP servers
// the account has (its claude.ai connectors among them, whose instructions
// a review once found in its tool output), which a headless task has no
// business reaching.
// `noTools` leaves the run without any tool, MCP servers included: a plain
// call to the model, like the exploration's commit subject
// (domains/explorations/pr.ts).
// `pluginDir` loads ronin's skills (`--plugin-dir`, as `ronin:<skill>`) and
// leaves out the product repo's .claude/ settings, hooks and skills
// (`--setting-sources user`); its CLAUDE.md still loads. `sealedEnv` runs
// the agent with an environment built from scratch — AGENT_ENV_KEYS, its
// Claude account, GH_TOKEN and these variables — instead of ronin's own,
// which carries every secret of .env (#257). `runAs` runs it as the agent's
// user (agents/agent-user.ts), with its Claude account lent to that user.
export interface HeadlessRunOptions {
  model?: string;
  effort?: string;
  agentsFile?: string;
  mcpConfigFile?: string;
  noTools?: boolean;
  pluginDir?: string;
  // Without the product repo's .claude/ settings, hooks and skills, even
  // without ronin's skills: what pluginDir does on that side.
  userSettingsOnly?: boolean;
  sealedEnv?: Record<string, string>;
  runAs?: AgentUser;
  // Told the pid of `claude` as soon as it starts: the actions server
  // answers only it and its descendants (actions/peer.ts).
  onSpawn?: (pid: number) => void;
}

// What a sealed run keeps of ronin's environment: what the tools an agent
// runs need (git, gh, pnpm, playwright), none of ronin's secrets. Not
// Docker's: the services its tests need go through ronin's actions.
export const AGENT_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ',
  'IS_SANDBOX', 'DISABLE_AUTOUPDATER', 'PLAYWRIGHT_BROWSERS_PATH',
];

export function sealedAgentEnv(base: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_KEYS) if (base[key] !== undefined) env[key] = base[key];
  return { ...env, ...vars };
}

// The arguments of every headless run; shared with scripts/fix-replay.ts so
// a replay runs on the same model and effort as the real task.
export function claudeHeadlessArgs(prompt: string, opts: HeadlessRunOptions = {}): string[] {
  const model = opts.model ?? defaultAgentModel();
  const effort = opts.effort ?? defaultAgentEffort();
  return [
    '-p', prompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(opts.agentsFile ? ['--agents', opts.agentsFile] : []),
    ...(opts.mcpConfigFile ? ['--mcp-config', opts.mcpConfigFile] : []),
    '--strict-mcp-config',
    ...(opts.noTools ? ['--tools', ''] : []),
    ...(opts.pluginDir ? ['--plugin-dir', opts.pluginDir] : []),
    ...(opts.pluginDir || opts.userSettingsOnly ? ['--setting-sources', 'user'] : []),
  ];
}

// `sink`, when given, gets every step and the final totals as they stream
// (the run's record, run-record.ts). Every run also leaves its account's
// usage behind, from the rate_limit_event (claude-usage.ts).
export async function runClaudeHeadless(cwd: string, prompt: string, label: string, opts: HeadlessRunOptions = {}, sink?: RunSink): Promise<string> {
  const env: NodeJS.ProcessEnv = opts.sealedEnv
    ? sealedAgentEnv(process.env, { ...(config.githubToken ? { GH_TOKEN: config.githubToken } : {}), ...opts.sealedEnv })
    : { ...process.env, GH_TOKEN: config.githubToken };
  // ronin's own NODE_ENV (production in the image) would make the agent's
  // `pnpm install` in the product repo skip its devDependencies.
  delete env.NODE_ENV;
  // A repos.json entry's own claudeConfigDir wins over the global default —
  // lets each repo run under its own Claude account (docs/superpowers/specs/
  // 2026-08-19-multi-repo-pat-auth-design.md §2).
  const claudeConfigDir = activeRepo().claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  if (opts.runAs && claudeConfigDir) await lendClaudeAccount(claudeConfigDir, opts.runAs);

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.claudeCommand,
      claudeHeadlessArgs(prompt, opts),
      // stdin explicitly closed ('ignore'): an unset stdio here defaults to
      // an open, never-written pipe, which makes `claude -p` wait ~3s for
      // input before warning and proceeding without it on every single run.
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.runAs ? { uid: opts.runAs.uid, gid: opts.runAs.gid } : {}) },
    );

    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
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
      if (event.type === 'result') {
        finalResult = String(event.result ?? '');
        sink?.result(resultStats(event));
      } else if (event.type === 'rate_limit_event') {
        void recordRateLimit(claudeConfigDir ?? '', event.rate_limit_info);
      } else {
        for (const step of streamSteps(event)) {
          logStep(label, step);
          sink?.step(step);
        }
      }
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
      else if (timedOut) reject(new ClaudeTimeoutError(`${config.claudeCommand} timed out after ${config.agentTaskTimeoutMs}ms`));
      else if (usageLimitHit) {
        void recordUsageLimitHit(claudeConfigDir ?? '');
        reject(new ClaudeUsageLimitError(`${config.claudeCommand} hit its usage/spend limit`));
      }
      else reject(new Error(`${config.claudeCommand} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
