import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin', worktreeBaseRef: 'origin/main' } }));
vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

let base: string;
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/tienda', productRepoPath: '/repo', worktreeBasePath: base }) }));
const agent = { name: 'agent-acme', uid: 1600, gid: 1600, home: '/home/agent-acme' };
vi.mock('@platform/agents/agent-user.js', () => ({
  repoAgentUser: () => agent,
  prepareAgentUser: async () => {},
  asAgent: (user: typeof agent, opts: object) => ({ ...opts, uid: user.uid, gid: user.gid }),
}));
const agentCloneAt = vi.fn();
vi.mock('@platform/git/worktree.js', () => ({ agentCloneAt: (...args: unknown[]) => agentCloneAt(...args) }));
const exec = vi.fn();
vi.mock('@platform/host/host.js', async () => {
  const fs = await import('node:fs/promises');
  return {
    host: () => ({
      exec: (...args: unknown[]) => exec(...args),
      browserMcp: (args: string[]) => ({ command: 'playwright-mcp', args }),
      fs: {
        readFile: (path: string, encoding?: 'utf8') => fs.readFile(path, encoding),
        writeFile: (path: string, data: string) => fs.writeFile(path, data),
        mkdir: async (path: string, opts?: object) => { await fs.mkdir(path, opts); },
        rm: (path: string, opts?: object) => fs.rm(path, opts),
        exists: (path: string) => fs.access(path).then(() => true, () => false),
      },
    }),
  };
});
const appUp = vi.fn();
const appDown = vi.fn();
const removeAppCheckout = vi.fn();
const loginAllUsers = vi.fn();
vi.mock('../product-app/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appUp: (...args: unknown[]) => appUp(...args),
  appDown: (...args: unknown[]) => appDown(...args),
  removeAppCheckout: (...args: unknown[]) => removeAppCheckout(...args),
  loginAllUsers: (...args: unknown[]) => loginAllUsers(...args),
  loadAppDefinition: async () => ({ path: 'apps/tienda', users: [{ role: 'Admin', username: 'admin@ejemplo.com', password: 'clave' }], viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844, isMobile: true } } }),
}));
const appStack = vi.fn();
vi.mock('../product-app/services.js', () => ({ appStack: (...args: unknown[]) => appStack(...args) }));
const runAgentTask = vi.fn();
vi.mock('@platform/agents/agent-task.js', () => ({ runAgentTask: (...args: unknown[]) => runAgentTask(...args) }));

const { runOnApp } = await import('./app-run.js');

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(join(tmpdir(), 'ronin-app-run-'));
  const dir = join(base, 'prototype-portal-p-3');
  agentCloneAt.mockImplementation(async () => { await mkdir(dir, { recursive: true }); return dir; });
  exec.mockResolvedValue({ stdout: '', stderr: '' });
  const state = join(base, '.ronin-app', 'prototype-portal-p-3', 'auth');
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'Admin.json'), '{"cookies":[]}');
  loginAllUsers.mockResolvedValue({ Admin: join(state, 'Admin.json') });
  appUp.mockResolvedValue({ baseUrl: 'http://127.0.0.1:41000', ctx: { ports: {}, port: {} } });
  appStack.mockReturnValue({ exec: vi.fn() });
});

describe("runOnApp on the agent's clone", () => {
  it("brings the app up as the agent and gives its browsers what they read in the run's own dir", async () => {
    const image = join(base, 'foto.png');
    await writeFile(image, 'png');
    let staged = '';
    let base_: { outDir: string; mcpConfigPath: string } | undefined;
    await runOnApp({
      key: 'portal-p-3',
      appName: 'tienda',
      task: async (b, { app, stage }) => {
        base_ = b;
        staged = await stage(image);
        expect(app).toBe(appStack.mock.results[0].value);
        return { type: 'portal-prototype', prepare: vi.fn() } as never;
      },
    }, async (run) => run.diff());

    const dir = join(base, 'prototype-portal-p-3');
    expect(agentCloneAt).toHaveBeenCalledWith(dir, 'origin/main', agent);
    expect(appUp).toHaveBeenCalledWith(dir, 'tienda', { instance: 'portal-p-3', as: agent });
    expect(appStack).toHaveBeenCalledWith(dir, agent);
    // The run's files are inside its output dir; the request's image too.
    expect(staged.startsWith(join(base_!.outDir, 'request'))).toBe(true);
    // Gone with the output dir once the run is over.
    expect(await readFile(base_!.mcpConfigPath, 'utf8').catch(() => null)).toBeNull();
    // ronin's git there runs as the agent.
    const inClone = exec.mock.calls.filter(([file, , opts]) => file === 'git' && opts?.cwd === dir);
    expect(inClone.length).toBeGreaterThan(0);
    expect(inClone.every(([, , opts]) => opts.uid === 1600)).toBe(true);
    expect(removeAppCheckout).toHaveBeenCalledWith(dir, 'prototype');
  });

  it('points each browser at a copy of its login in the output dir', async () => {
    let mcp: { mcpServers: Record<string, { args: string[] }> } | undefined;
    let outDir = '';
    await runOnApp({
      key: 'portal-p-3',
      appName: 'tienda',
      task: async (b) => {
        outDir = b.outDir;
        mcp = JSON.parse(await readFile(b.mcpConfigPath, 'utf8'));
        return { type: 'portal-prototype', prepare: vi.fn() } as never;
      },
    }, async () => null);

    const args = mcp!.mcpServers['admin-desktop'].args;
    expect(args[args.indexOf('--storage-state') + 1]).toBe(join(outDir, 'auth', 'Admin.json'));
    expect(args[args.indexOf('--output-dir') + 1]).toBe(join(outDir, 'admin-desktop'));
  });
});
