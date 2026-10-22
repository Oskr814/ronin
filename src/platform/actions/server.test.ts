import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { startActionsServer, type ActionsServer } from './server.js';
import type { RunScope, ValidAction } from './catalog.js';

const execFileAsync = promisify(execFile);
const CLI = resolve('bin/ronin-act');

const scope: RunScope = {
  prNumber: 7,
  headRef: 'feat/x',
  startSha: 'start',
  threads: [{ commentId: 100, threadId: 'PRRT_a' }],
  triggers: [{ id: 300, kind: 'issue' }],
  allowed: ['pr.reply', 'pr.comment', 'git.push', 'services.run', 'result.report'],
};

let server: ActionsServer | null = null;
const executed: ValidAction[] = [];

async function start(execute = async (action: ValidAction): Promise<Record<string, unknown>> => { executed.push(action); return {}; }): Promise<ActionsServer> {
  executed.length = 0;
  server = await startActionsServer({
    scope,
    label: 'test',
    checkout: async () => ({ head: 'amended', parentOfHead: 'base', parentOfStart: 'base', dirty: false, onBase: true, onStart: false }),
    execute,
  });
  // The CLI runs as a child of this process, as ronin-act does of claude.
  server.bind(process.pid);
  return server;
}

// The agent's side: the CLI, with only the run's URL and credential.
async function act(s: ActionsServer, args: string[], token = s.token): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(CLI, args, { env: { PATH: process.env.PATH, RONIN_ACTIONS_URL: s.url, RONIN_ACTIONS_TOKEN: token } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('actions server + ronin-act', () => {
  it("lists the run's actions and each one's arguments", async () => {
    const s = await start();
    const listed = await act(s, []);
    expect(listed.stdout).toContain('pr.reply');
    expect(listed.stdout).not.toContain('pr.resolve-thread');
    expect((await act(s, ['pr.reply', '--help'])).stdout).toContain('--body-file');
  });

  it('runs an accepted action, from flags and from a file', async () => {
    const s = await start();
    const dir = await mkdtemp(join(tmpdir(), 'ronin-act-'));
    await writeFile(join(dir, 'reply.md'), 'Listo: lo cambié.');
    expect((await act(s, ['pr.reply', '--comment-id', '100', '--body-file', join(dir, 'reply.md')])).code).toBe(0);
    expect(executed).toEqual([{ name: 'pr.reply', input: { commentId: 100, body: 'Listo: lo cambié.' } }]);
  });

  it('says why an action was refused, and does nothing', async () => {
    const s = await start();
    const refused = await act(s, ['pr.comment', '--body', 'Como dijo @persona']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('menciona a la persona por su rol');
    expect(executed).toEqual([]);
    expect(s.calls).toMatchObject([{ name: 'pr.comment', outcome: 'refused' }]);
  });

  it('keeps what result.report said', async () => {
    const s = await start();
    const report = { threads: [{ commentId: 100, changed: true, reply: 'Cambiado.' }], summary: 'Un hilo arreglado.' };
    expect((await act(s, ['result.report', '--json', JSON.stringify(report)])).code).toBe(0);
    expect(s.report()).toEqual(report);
  });

  it("prints a command's output as text, not inside the JSON", async () => {
    const s = await start(async () => ({ exitCode: 1, output: 'Passed: 3\nFailed: 1' }));
    const ran = await act(s, ['services.run', '--service', 'web', '--command', 'dotnet test']);
    expect(ran.stdout).toBe('{"ok":true,"exitCode":1}\nPassed: 3\nFailed: 1\n');
  });

  it("answers only the run's own processes", async () => {
    const s = await start();
    s.bind(1);
    const stolen = await act(s, ['pr.comment', '--body', 'hola']);
    expect(stolen.stderr).toContain('no viene de la corrida');
    expect(executed).toEqual([]);
  });

  it('turns away a wrong credential', async () => {
    const s = await start();
    expect((await act(s, [], 'otra')).stderr).toContain('credencial inválida');
  });

  it("doesn't tell the agent ronin's own errors", async () => {
    const s = await start(async () => { throw new Error('gh: token sin permisos'); });
    const failed = await act(s, ['git.push']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('falló del lado de ronin');
    expect(failed.stderr).not.toContain('token');
    expect(s.calls).toMatchObject([{ name: 'git.push', outcome: 'error' }]);
  });
});
