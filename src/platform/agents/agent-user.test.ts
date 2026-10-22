import { describe, it, expect, vi, beforeEach } from 'vitest';

const config = { agentUidBase: 1500 as number | null, agentHomeBase: '/home', claudeConfigDir: '/claude/default' };
vi.mock('../config/config.js', () => ({ config }));
const exec = vi.fn();
vi.mock('../host/host.js', () => ({ host: () => ({ exec: (...args: unknown[]) => exec(...args) }) }));
const repo = { productRepo: 'acme/tienda', productRepoPath: '/repos/acme/tienda/repo', worktreeBasePath: '/repos/acme/tienda/ronin-worktrees', claudeConfigDir: '/claude/acme' };
vi.mock('./repo-context.js', () => ({ activeRepo: () => repo }));
const other = { productRepo: 'otra/app', productRepoPath: '/repos/otra/app/repo', claudeConfigDir: '/claude/otra' };
vi.mock('../config/repos.js', () => ({ loadRepos: async () => [repo, other] }));

const { agentUserFor, prepareAgentUser } = await import('./agent-user.js');

// The image's layout: worktrees next to each repo's clone (test/setup-env.ts
// points them elsewhere for every other test).
const savedWorktrees = process.env.WORKTREE_BASE_PATH;
beforeEach(() => {
  vi.clearAllMocks();
  config.agentUidBase = 1500;
  process.env.WORKTREE_BASE_PATH = '';
  return () => { process.env.WORKTREE_BASE_PATH = savedWorktrees; };
});

describe('agentUserFor', () => {
  it('gives each Claude account its own user, the same one every time', () => {
    const acme = agentUserFor('/claude/acme')!;
    expect(acme).toEqual(agentUserFor('/claude/acme'));
    expect(acme.name).toBe('agent-acme');
    expect(acme.home).toBe('/home/agent-acme');
    expect(acme.uid).toBeGreaterThan(1500);
    expect(acme.gid).toBe(acme.uid);
    expect(agentUserFor('/claude/otra')!.uid).not.toBe(acme.uid);
  });

  it('is none without the image saying where the users go', () => {
    config.agentUidBase = null;
    expect(agentUserFor('/claude/acme')).toBeNull();
  });
});

describe('prepareAgentUser', () => {
  it("makes each account's user once, and closes every repo to the other accounts' agents", async () => {
    const user = agentUserFor('/claude/acme')!;
    const otherUser = agentUserFor('/claude/otra')!;
    exec.mockImplementation(async (file: string) => (file === 'getent' ? Promise.reject(new Error('no')) : { stdout: '', stderr: '' }));

    await prepareAgentUser(user);
    await prepareAgentUser(user);

    expect(exec.mock.calls.filter(([file]) => file === 'useradd').map(([, args]) => args.at(-1))).toEqual(['agent-acme', 'agent-otra']);
    expect(exec).toHaveBeenCalledWith('useradd', ['--uid', String(user.uid), '--user-group', '--create-home', '--home-dir', '/home/agent-acme', '--shell', '/bin/bash', 'agent-acme']);
    expect(exec).toHaveBeenCalledWith('chgrp', [String(user.gid), '/repos/acme/tienda']);
    expect(exec).toHaveBeenCalledWith('chgrp', [String(otherUser.gid), '/repos/otra/app']);
    expect(exec.mock.calls.filter(([file]) => file === 'chmod')).toEqual([['chmod', ['750', '/repos/acme/tienda']], ['chmod', ['750', '/repos/otra/app']]]);
  });

  it('refuses a uid another user already has', async () => {
    const user = agentUserFor('/claude/choque')!;
    exec.mockImplementation(async (file: string) => (file === 'getent' ? { stdout: `otro:x:${user.uid}:${user.uid}::/home/otro:/bin/sh\n`, stderr: '' } : { stdout: '', stderr: '' }));

    await expect(prepareAgentUser(user)).rejects.toThrow('ya es de otro');
  });
});
