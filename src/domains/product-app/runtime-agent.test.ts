import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@platform/config/config.js', () => ({ config: { worktreeBaseRef: 'origin/main' } }));
vi.mock('@platform/agents/repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'acme/tienda', productRepoPath: '/repo', worktreeBasePath: '/wt' }),
}));
let nextPort = 41000;
vi.mock('@platform/git/worktree.js', () => ({ getFreePort: async () => nextPort++ }));

const exec = vi.fn();
const runLogged = vi.fn();
const startLogged = vi.fn();
const stopGroup = vi.fn();
vi.mock('@platform/host/host.js', () => ({
  host: () => ({
    fs: {
      readFile: (path: string, encoding?: 'utf8') => fsp.readFile(path, encoding),
      writeFile: (path: string, data: string) => fsp.writeFile(path, data),
      appendFile: (path: string, data: string) => fsp.appendFile(path, data),
      mkdir: async (path: string, opts?: { recursive?: boolean; mode?: number }) => { await fsp.mkdir(path, opts); },
      rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => fsp.rm(path, opts),
      exists: (path: string) => fsp.access(path).then(() => true, () => false),
    },
    exec: (...args: unknown[]) => exec(...args),
    runLogged: (...args: unknown[]) => runLogged(...args),
    startLogged: (...args: unknown[]) => startLogged(...args),
    stopGroup: (...args: unknown[]) => stopGroup(...args),
  }),
}));

const { appDown, appUp, removeAppState } = await import('./runtime.js');

const manifest = JSON.stringify({
  apps: {
    tienda: {
      path: 'apps/tienda',
      compose: { files: ['compose.dev.yml'] },
      steps: [
        { compose: 'up' },
        { run: 'pnpm install' },
        { run: '{{compose}} exec -T db psql -f /seed.sql' },
        { name: 'web', start: 'vite --port {{port.web}}' },
      ],
      baseUrl: 'http://127.0.0.1:{{port.web}}',
      users: [{ role: 'Admin', username: 'admin@ejemplo.com', password: 'clave' }],
      login: [{ goto: '/login' }],
    },
  },
});

const agent = { name: 'agent-acme', uid: 1600, gid: 1600, home: '/home/agent-acme' };

let worktrees: string;
let dir: string;
beforeEach(async () => {
  vi.clearAllMocks();
  worktrees = await mkdtemp(join(tmpdir(), 'ronin-app-'));
  dir = join(worktrees, 'agent-prototype-portal-p-3');
  await fsp.mkdir(dir);
  exec.mockResolvedValue({ stdout: JSON.stringify({ services: { db: { image: 'postgres' } } }), stderr: '' });
  startLogged.mockReturnValue(4242);
  vi.stubGlobal('fetch', async () => ({ status: 200 }));
  vi.stubEnv('ANTHROPIC_API_KEY', 'secreto');
  return () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); };
});

describe("an app on the agent's checkout", () => {
  it('keeps its state out of the checkout, where the agent cannot write it', async () => {
    const session = await appUp(dir, 'tienda', { manifest, as: agent });
    const outside = join(worktrees, '.ronin-app', 'agent-prototype-portal-p-3');
    expect(session.stateDir).toBe(outside);
    expect(JSON.parse(await fsp.readFile(join(outside, 'state.json'), 'utf8'))).toMatchObject({ processes: [{ name: 'web', pid: 4242 }], as: agent });
    expect((await fsp.stat(outside)).mode & 0o777).toBe(0o700);
    expect(await fsp.access(join(dir, '.ronin-app')).then(() => true, () => false)).toBe(false);
    // ronin runs no git in it.
    expect(exec.mock.calls.filter(([file]) => file === 'git')).toEqual([]);
  });

  it("runs the app's code as the agent, with nothing of ronin's environment, and only the stack's steps as ronin", async () => {
    await appUp(dir, 'tienda', { manifest, as: agent });
    const install = runLogged.mock.calls.find(([command]) => command === 'pnpm install')![1];
    expect(install).toMatchObject({ cwd: dir, uid: 1600, gid: 1600, env: { HOME: '/home/agent-acme', CI: 'true', RONIN_APP_PROCESS: '1' } });
    expect(install.env.ANTHROPIC_API_KEY).toBeUndefined();
    const [seed, asRonin] = runLogged.mock.calls.find(([command]) => command.includes('psql'))!;
    expect(seed).toBe(`'docker' 'compose' '-p' 'ronin-app-acme-tienda-tienda' '-f' '${join(worktrees, '.ronin-app', 'agent-prototype-portal-p-3', 'compose.json')}' 'exec' '-T' 'db' 'psql' '-f' '/seed.sql'`);
    expect(asRonin.uid).toBeUndefined();
    const [, web] = startLogged.mock.calls[0];
    expect(web).toMatchObject({ uid: 1600, gid: 1600, env: { HOME: '/home/agent-acme' } });
    expect(web.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does not bring up a stack that reaches beyond the checkout', async () => {
    exec.mockResolvedValue({ stdout: JSON.stringify({ services: { db: { image: 'postgres', volumes: [{ type: 'bind', source: '/data' }] } } }), stderr: '' });
    await expect(appUp(dir, 'tienda', { manifest, as: agent })).rejects.toThrow('db: monta /data, fuera del checkout');
    expect(runLogged).not.toHaveBeenCalled();
  });

  it('never reads a state the agent left in the checkout', async () => {
    await appUp(dir, 'tienda', { manifest, as: agent });
    await fsp.mkdir(join(dir, '.ronin-app'));
    await fsp.writeFile(join(dir, '.ronin-app', 'state.json'), JSON.stringify({ appName: 'tienda', project: 'otro', processes: [{ name: 'x', pid: 1 }] }));

    await appDown(dir);

    expect(stopGroup.mock.calls).toEqual([[4242]]);
    expect(exec).toHaveBeenLastCalledWith('docker', ['compose', '-p', 'ronin-app-acme-tienda-tienda', '-f', join(worktrees, '.ronin-app', 'agent-prototype-portal-p-3', 'compose.json'), 'down', '--volumes', '--remove-orphans'], expect.anything());

    await removeAppState(dir);
    expect(await fsp.access(join(worktrees, '.ronin-app', 'agent-prototype-portal-p-3')).then(() => true, () => false)).toBe(false);
  });
});
