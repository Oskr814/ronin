import { describe, it, expect, vi, beforeEach } from 'vitest';

const exec = vi.fn();
const writeFile = vi.fn();
const readFile = vi.fn();
vi.mock('@platform/host/host.js', () => ({
  host: () => ({ exec: (...args: unknown[]) => exec(...args), fs: { writeFile: (...a: unknown[]) => writeFile(...a), readFile: (...a: unknown[]) => readFile(...a) } }),
}));
vi.mock('@platform/agents/repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'acme/tienda', productRepoPath: '/repos/tienda/repo', worktreeBasePath: '/repos/tienda/wt' }),
}));
vi.mock('@platform/config/config.js', () => ({ config: { worktreeBaseRef: 'origin/main' } }));
vi.mock('@platform/git/worktree.js', () => ({ getFreePort: async () => 41000 }));

const { mountCheckout, runServices } = await import('./services.js');
const { ActionRefused } = await import('@platform/actions/catalog.js');

describe('mountCheckout', () => {
  it("points the repo's bind mounts at the run's checkout, and leaves the rest", () => {
    const resolved = {
      services: {
        web: { volumes: [
          { type: 'bind', source: '/wt/base', target: '/app' },
          { type: 'bind', source: '/wt/base/apps/api', target: '/api' },
          { type: 'bind', source: '/wt/base-otro', target: '/x' },
          { type: 'volume', source: 'nuget', target: '/root/.nuget' },
        ] },
        db: { image: 'postgres' },
      },
    };
    expect(mountCheckout(resolved, '/wt/base', '/wt/agent').services).toEqual({
      web: { volumes: [
        { type: 'bind', source: '/wt/agent', target: '/app' },
        { type: 'bind', source: '/wt/agent/apps/api', target: '/api' },
        { type: 'bind', source: '/wt/base-otro', target: '/x' },
        { type: 'volume', source: 'nuget', target: '/root/.nuget' },
      ] },
      db: { image: 'postgres' },
    });
  });
});

describe('runServices', () => {
  const compose = { services: { postgres: { image: 'postgres', ports: [{ target: 5432, published: '5434' }] }, web: { image: 'dotnet' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockResolvedValue(JSON.stringify({ apps: {
      tienda: { compose: { files: ['docker-compose.dev.yml'] } },
      backoffice: { compose: { files: ['docker-compose.dev.yml'] } },
    } }));
    exec.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === 'docker' && args.includes('config') ? JSON.stringify(compose) : '', stderr: '' }));
  });

  it("takes the compose from the base branch's ronin.app.json, never from the checkout", async () => {
    const services = runServices({ checkoutDir: '/repos/tienda/wt/agent-x', owner: null });
    expect(await services.up(['postgres'])).toEqual({ postgres: { '5432': 41000 } });

    const worktree = exec.mock.calls.find(([, args]) => args[0] === 'worktree')!;
    expect(worktree[1]).toEqual(['worktree', 'add', '--detach', expect.stringMatching(/^\/repos\/tienda\/wt\/services-/), 'origin/main']);
    const config = exec.mock.calls.find(([file, args]) => file === 'docker' && args.includes('config'))!;
    expect(config[1]).toEqual(['compose', '-f', 'docker-compose.dev.yml', 'config', '--format', 'json']);
    expect(config[2].cwd).toBe(worktree[1][3]);
    const up = exec.mock.calls.find(([file, args]) => file === 'docker' && args.includes('up'))!;
    expect(up[1]).toEqual(expect.arrayContaining(['-p', expect.stringMatching(/^ronin-svc-/), 'up', '-d', '--wait', 'postgres']));
  });

  it('refuses a service the compose does not have, naming the ones it has', async () => {
    const services = runServices({ checkoutDir: '/c', owner: null });
    await expect(services.up(['mysql'])).rejects.toThrow(new ActionRefused('el compose no tiene mysql; tiene: postgres, web'));
  });

  it("runs a command in a service, gives back its exit code, and returns what it wrote to the agent", async () => {
    const services = runServices({ checkoutDir: '/c', owner: { uid: 1500, gid: 1500, home: '/home/agent' } });
    exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'docker' && args.includes('config')) return { stdout: JSON.stringify(compose), stderr: '' };
      if (file === 'docker' && args.includes('run')) throw Object.assign(new Error('fail'), { code: 1, stdout: 'Passed: 3\nFailed: 1\n', stderr: ' Container web-run Created\n' });
      return { stdout: '', stderr: '' };
    });

    expect(await services.run('web', 'dotnet test')).toEqual({ exitCode: 1, output: 'Passed: 3\nFailed: 1\n' });
    expect(exec.mock.calls.find(([file, args]) => file === 'docker' && args.includes('run'))![1].slice(-4)).toEqual(['web', 'sh', '-c', 'exec 2>&1; dotnet test']);
    expect(exec).toHaveBeenCalledWith('chown', ['-R', '1500:1500', '/c']);
  });

  it('takes the stack and its checkout down at the end, only if it was started', async () => {
    const idle = runServices({ checkoutDir: '/c', owner: null });
    await idle.close();
    expect(exec).not.toHaveBeenCalled();

    const used = runServices({ checkoutDir: '/c', owner: null });
    await used.up(['postgres']);
    await used.close();
    expect(exec.mock.calls.some(([file, args]) => file === 'docker' && args.includes('down'))).toBe(true);
    expect(exec.mock.calls.some(([file, args]) => file === 'git' && args[0] === 'worktree' && args[1] === 'remove')).toBe(true);
  });
});
