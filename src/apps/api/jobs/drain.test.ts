import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { busyProcesses, drain } from './drain.js';

// A /proc with the runner (100), its init (1), and processes of its own
// container and of the API's, which shares the PID namespace.
const RUNNER = '0::/../runner.scope\n';
const API = '0::/../api.scope\n';
let dir: string;
function proc(pid: number, ppid: number, cgroup: string, state = 'S', name = 'node', env = 'PATH=/usr/bin\0') {
  mkdirSync(join(dir, String(pid)), { recursive: true });
  writeFileSync(join(dir, String(pid), 'stat'), `${pid} (${name}) ${state} ${ppid} 1 1 0 -1`);
  writeFileSync(join(dir, String(pid), 'cgroup'), cgroup);
  writeFileSync(join(dir, String(pid), 'environ'), env);
}
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('what the runner waits for before it goes', () => {
  it('its own processes still alive, and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    proc(1, 0, RUNNER, 'S', 'docker-init');
    proc(100, 1, RUNNER);
    writeFileSync(join(dir, 'self'), '');
    proc(200, 100, RUNNER, 'S', 'node handler');
    proc(201, 1, RUNNER, 'S', 'claude (agente) )');
    proc(202, 1, RUNNER, 'Z');
    proc(203, 0, RUNNER, 'S', 'bash');
    proc(300, 1, API);
    // A preview's dev server, and what it started: the app's, not a job.
    proc(400, 1, RUNNER, 'S', 'next-server', 'PATH=/usr/bin\0RONIN_APP_PROCESS=1\0CI=true\0');
    proc(401, 400, RUNNER, 'S', 'node', 'RONIN_APP_PROCESS=1\0');
    expect(busyProcesses(dir, 100).sort()).toEqual([200, 201]);
  });

  it('goes once nothing is left, saying how many are still running', async () => {
    const left = [2, 1, 0];
    const report = vi.fn();
    await drain(report, { pollMs: 1, reportEveryMs: 0, busy: () => left.shift()! });
    expect(report.mock.calls).toEqual([[2], [1]]);
  });
});
