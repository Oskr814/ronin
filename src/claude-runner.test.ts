import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('./config.js', () => ({
  config: {
    claudeCommand: 'claude',
    claudeConfigDir: '',
    agentTaskTimeoutMs: 30_000,
    githubToken: 'fake-token',
    agentModel: 'opus',
    agentEffort: 'high',
  },
}));

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let fakeChild: FakeChildProcess;
const spawn = vi.fn(() => fakeChild);
vi.mock('node:child_process', () => ({
  spawn: () => spawn(),
}));

const { runClaudeHeadless, ClaudeUsageLimitError, claudeHeadlessArgs } = await import('./claude-runner.js');
const { config } = await import('./config.js');
// The mock above is a plain object; the real config is typed read-only.
const mutableConfig = config as { agentModel: string; agentEffort: string };
const { withActiveRepo } = await import('./repo-context.js');

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

  it('passes an MCP config, and only that one', () => {
    const args = claudeHeadlessArgs('do it', { mcpConfigFile: '/tmp/mcp.json' });
    expect(args.join(' ')).toContain('--mcp-config /tmp/mcp.json --strict-mcp-config');
    expect(claudeHeadlessArgs('do it')).not.toContain('--mcp-config');
  });
});
