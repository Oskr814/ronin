import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { host, localHost, setHost, type Host } from './host.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-host-'));
});
afterEach(async () => {
  setHost(null);
  await rm(dir, { recursive: true, force: true });
});

describe('localHost', () => {
  it('runs a command to its end, as text or as bytes', async () => {
    expect((await localHost.exec('sh', ['-c', 'printf hola; printf mal >&2'], { cwd: dir })).stdout).toBe('hola');
    expect((await localHost.exec('sh', ['-c', 'printf hola; printf mal >&2'], { cwd: dir })).stderr).toBe('mal');
    expect((await localHost.execBuffer('printf', ['\\001\\002'])).stdout).toEqual(Buffer.from([1, 2]));
  });

  it("fails as execFile does, with the command's output", async () => {
    await expect(localHost.exec('sh', ['-c', 'echo nope >&2; exit 3'])).rejects.toMatchObject({ code: 3, stderr: 'nope\n' });
  });

  it('runs a logged command, and fails with the end of its log', async () => {
    const logFile = join(dir, 'app.log');
    await localHost.runLogged('echo listo', { cwd: dir, env: process.env, logFile, timeoutMs: 5_000 });
    expect(await readFile(logFile, 'utf8')).toBe('\n$ echo listo\nlisto\n');
    await expect(localHost.runLogged('echo se rompió; exit 2', { cwd: dir, env: process.env, logFile, timeoutMs: 5_000 })).rejects.toThrow(/salió con código 2[\s\S]*se rompió/);
  });

  it('leaves a process running in its own group, and stops it', async () => {
    const pid = localHost.startLogged('sleep 30', { cwd: dir, env: process.env, logFile: join(dir, 'server.log') });
    expect(localHost.alive(pid)).toBe(true);
    await localHost.stopGroup(pid);
    await new Promise((r) => setTimeout(r, 100));
    expect(localHost.alive(pid)).toBe(false);
  });

  it('finds a free port, and starts the browser MCP from node_modules', async () => {
    expect(await localHost.freePort()).toBeGreaterThan(0);
    expect(localHost.browserMcp(['--headless'])).toEqual({ command: join(process.cwd(), 'node_modules', '.bin', 'playwright-mcp'), args: ['--headless'] });
  });
});

describe('host()', () => {
  it('is this machine unless another one is set', () => {
    expect(host()).toBe(localHost);
    const other = { ...localHost, name: 'otra' } as Host;
    setHost(other);
    expect(host().name).toBe('otra');
    setHost(null);
    expect(host()).toBe(localHost);
  });
});
