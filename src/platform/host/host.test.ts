import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { host, localHost } from './host.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ronin-host-'));
});
afterEach(async () => {
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

describe('localHost.fs', () => {
  it('writes, appends and reads a file, as text or as bytes', async () => {
    const file = join(dir, 'a', 'b.txt');
    await localHost.fs.mkdir(join(dir, 'a'), { recursive: true });
    await localHost.fs.writeFile(file, 'hola');
    await localHost.fs.appendFile(file, ' mundo');
    expect(await localHost.fs.readFile(file, 'utf8')).toBe('hola mundo');
    expect(await localHost.fs.readFile(file)).toEqual(Buffer.from('hola mundo'));
  });

  it("doesn't overwrite with the wx flag", async () => {
    const file = join(dir, 'c.txt');
    await localHost.fs.writeFile(file, 'primero', { flag: 'wx' });
    await expect(localHost.fs.writeFile(file, 'segundo', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('primero');
  });

  it('lists a directory, by name or with its entry types', async () => {
    await localHost.fs.mkdir(join(dir, 'sub'));
    await localHost.fs.writeFile(join(dir, 'f.txt'), '');
    expect((await localHost.fs.readdir(dir)).sort()).toEqual(['f.txt', 'sub']);
    const entries = await localHost.fs.readdir(dir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual(['sub']);
    expect(entries.filter((e) => e.isFile()).map((e) => e.name)).toEqual(['f.txt']);
  });

  it('says whether a path exists, and removes it', async () => {
    await localHost.fs.mkdir(join(dir, 'x', 'y'), { recursive: true });
    expect(await localHost.fs.exists(join(dir, 'x', 'y'))).toBe(true);
    await localHost.fs.rm(join(dir, 'x'), { recursive: true, force: true });
    expect(await localHost.fs.exists(join(dir, 'x'))).toBe(false);
    await expect(localHost.fs.rm(join(dir, 'x'), { force: true })).resolves.toBeUndefined();
  });

  it('makes a temp dir in its own temp dir', async () => {
    const temp = await localHost.fs.mkdtemp('ronin-host-test-');
    try {
      expect(temp.startsWith(join(tmpdir(), 'ronin-host-test-'))).toBe(true);
      expect(await localHost.fs.exists(temp)).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('host()', () => {
  it('is this machine', () => {
    expect(host()).toBe(localHost);
  });
});
