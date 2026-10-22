import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../config/config.js', () => {
  const config = {
    claudeCommand: 'claude',
    claudeConfigDir: '',
    agentTaskTimeoutMs: 30_000,
    githubToken: 'fake-token',
    agentModel: 'opus',
    agentEffort: 'high',
  };
  return { config, defaultAgentModel: () => config.agentModel, defaultAgentEffort: () => config.agentEffort };
});

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let fakeChild: FakeChildProcess;
const spawn = vi.fn((..._args: unknown[]) => fakeChild);
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawn(...args),
}));

const lendClaudeAccount = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../agents/agent-user.js', () => ({ lendClaudeAccount: (...args: unknown[]) => lendClaudeAccount(...args) }));

const { runClaudeHeadless, ClaudeUsageLimitError, claudeHeadlessArgs, sealedAgentEnv, streamSteps } = await import('./claude-runner.js');
const { config } = await import('../config/config.js');
// The mock above is a plain object; the real config is typed read-only.
const mutableConfig = config as { agentModel: string; agentEffort: string };
const { withActiveRepo } = await import('../agents/repo-context.js');
const { readAccountUsage } = await import('./claude-usage.js');

function emitStdout(child: FakeChildProcess, text: string): void {
  child.stdout.emit('data', Buffer.from(`${text}\n`));
}

function runInRepo(cwd: string, prompt: string, label: string): Promise<string> {
  return withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, () => runClaudeHeadless(cwd, prompt, label));
}

describe('runClaudeHeadless usage-limit detection', () => {
  it('throws ClaudeUsageLimitError when the notice is a bare non-JSON stdout line', async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitStdout(fakeChild, "You've hit your monthly spend limit · raise it at claude.ai/settings/usage");
    fakeChild.emit('close', 1);
    await expect(promise).rejects.toBeInstanceOf(ClaudeUsageLimitError);
  });

  it('throws ClaudeUsageLimitError when the notice is embedded in a JSON stream-json event', async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const jsonLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" }] },
    });
    emitStdout(fakeChild, jsonLine);
    fakeChild.emit('close', 1);
    await expect(promise).rejects.toBeInstanceOf(ClaudeUsageLimitError);
  });
});

describe('claudeHeadlessArgs', () => {
  it('pins the model and effort instead of inheriting the shared Claude config', () => {
    const args = claudeHeadlessArgs('do it');
    expect(args.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--effort high');
  });

  it('leaves them to the Claude config when set empty', () => {
    const saved = { model: mutableConfig.agentModel, effort: mutableConfig.agentEffort };
    mutableConfig.agentModel = '';
    mutableConfig.agentEffort = '';
    try {
      const args = claudeHeadlessArgs('do it');
      expect(args).not.toContain('--model');
      expect(args).not.toContain('--effort');
    } finally {
      mutableConfig.agentModel = saved.model;
      mutableConfig.agentEffort = saved.effort;
    }
  });

  it('leaves a plain call without any tool or MCP server', () => {
    const args = claudeHeadlessArgs('do it', { noTools: true });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('passes an MCP config, and only that one', () => {
    const args = claudeHeadlessArgs('do it', { mcpConfigFile: '/tmp/mcp.json' });
    expect(args.join(' ')).toContain('--mcp-config /tmp/mcp.json --strict-mcp-config');
    expect(claudeHeadlessArgs('do it')).not.toContain('--mcp-config');
  });

  it("keeps out the account's own MCP servers on every run", () => {
    expect(claudeHeadlessArgs('do it')).toContain('--strict-mcp-config');
    expect(claudeHeadlessArgs('do it', { noTools: true }).filter((a) => a === '--strict-mcp-config')).toHaveLength(1);
  });

  it("loads ronin's skills without the product repo's settings", () => {
    const args = claudeHeadlessArgs('do it', { pluginDir: '/app/plugin' });
    expect(args.join(' ')).toContain('--plugin-dir /app/plugin --setting-sources user');
    expect(claudeHeadlessArgs('do it')).not.toContain('--plugin-dir');
  });
});

describe("runClaudeHeadless as the agent's user", () => {
  it('lends it the Claude account and spawns claude with its ids', async () => {
    const { config } = await import('../config/config.js');
    (config as { claudeConfigDir: string }).claudeConfigDir = '/claude/cuenta';
    try {
      fakeChild = new FakeChildProcess();
      const user = { name: 'agent-cuenta', uid: 1500, gid: 1500, home: '/home/agent' };
      const running = withActiveRepo({ productRepo: 'acme/tienda', productRepoPath: '/tmp/x' }, () => runClaudeHeadless('/tmp', 'hi', 'test', { runAs: user, sealedEnv: {} }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      fakeChild.emit('close', 0);
      await running;
      expect(lendClaudeAccount).toHaveBeenCalledWith('/claude/cuenta', user);
      expect(spawn.mock.calls.at(-1)![2]).toMatchObject({ uid: 1500, gid: 1500 });
    } finally {
      (config as { claudeConfigDir: string }).claudeConfigDir = '';
    }
  });
});

describe('sealedAgentEnv', () => {
  it("keeps what the tools need and none of ronin's secrets nor Docker", () => {
    const env = sealedAgentEnv(
      { PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'tcp://localhost:2376', DATABASE_URL: 'postgres://x', RONIN_GITHUB_TOKEN: 'secret', GMAIL_APP_PASSWORD: 'secret' },
      { RONIN_ACTIONS_URL: 'http://127.0.0.1:1', PATH: '/app/bin:/usr/bin' },
    );
    // Not Docker either: the services of its tests go through ronin's actions.
    expect(env).toEqual({ PATH: '/app/bin:/usr/bin', HOME: '/root', RONIN_ACTIONS_URL: 'http://127.0.0.1:1' });
  });
});

describe('runClaudeHeadless run record and usage', () => {
  it('hands every step and the final totals to the sink, as they stream', async () => {
    fakeChild = new FakeChildProcess();
    const sink = { step: vi.fn(), result: vi.fn() };
    const promise = withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, () => runClaudeHeadless('/tmp/wt', 'prompt', 'label', {}, sink));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitStdout(fakeChild, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Leo el issue' }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
    }));
    emitStdout(fakeChild, JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: '1 test falla' }] }] },
    }));
    emitStdout(fakeChild, JSON.stringify({
      type: 'result', result: 'listo', session_id: 's1', total_cost_usd: 0.5, num_turns: 4,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    }));
    fakeChild.emit('close', 0);

    await expect(promise).resolves.toBe('listo');
    expect(sink.step.mock.calls.map(([step]) => step)).toEqual([
      { kind: 'text', text: 'Leo el issue' },
      { kind: 'tool', name: 'Bash', summary: '$ pnpm test' },
      { kind: 'tool_error', text: '1 test falla' },
    ]);
    expect(sink.result).toHaveBeenCalledWith({
      sessionId: 's1', costUsd: 0.5, numTurns: 4, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40,
    });
  });

  it("keeps the account's usage from the rate_limit_event", async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitStdout(fakeChild, JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1792116600 }, seven_day: { utilization: 0.17, resetsAt: 1792544400 } } },
    }));
    fakeChild.emit('close', 0);
    await promise;
    expect(readAccountUsage('default')).toMatchObject({ fiveHour: { utilization: 0.4 }, sevenDay: { utilization: 0.17 } });
  });

  it('marks the account out of quota when the run hits the usage limit', async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitStdout(fakeChild, "You've hit your usage limit");
    fakeChild.emit('close', 1);
    await expect(promise).rejects.toBeInstanceOf(ClaudeUsageLimitError);
    expect(readAccountUsage('default')).toHaveProperty('limitHitAt');
  });
});

describe('streamSteps', () => {
  it("sums up a subagent by what it was asked, not its raw input", () => {
    const event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { description: 'worker de tests', prompt: 'largo…' } }] } };
    expect(streamSteps(event)).toEqual([{ kind: 'tool', name: 'Task', summary: 'worker de tests' }]);
  });
});
