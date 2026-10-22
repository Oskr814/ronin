import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionFromRun, descendsFrom, socketInode } from './peer.js';

// A /proc with: claude (100) → bash (200) → ronin-act (300), which holds
// the client socket 127.0.0.1:40000 → :39000; and another run's process
// (900), child of init.
async function fakeProc(): Promise<string> {
  const proc = await mkdtemp(join(tmpdir(), 'ronin-proc-'));
  await mkdir(join(proc, 'net'));
  await writeFile(join(proc, 'net', 'tcp'), [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:9858 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1',
    '   1: 0100007F:9C40 0100007F:9858 01 00000000:00000000 00:00000000 00000000  1500        0 22222 1',
  ].join('\n'));
  for (const [pid, ppid, fds] of [[100, 1, []], [200, 100, []], [300, 200, ['socket:[22222]']], [900, 1, []]] as const) {
    await mkdir(join(proc, String(pid), 'fd'), { recursive: true });
    await writeFile(join(proc, String(pid), 'stat'), `${pid} (proc name) S ${ppid} 0 0`);
    for (const [i, target] of fds.entries()) await symlink(target, join(proc, String(pid), 'fd', String(i)));
  }
  return proc;
}

describe('peer', () => {
  it("finds the client socket's inode by its ports", async () => {
    const proc = await fakeProc();
    expect(socketInode(40000, 39000, proc)).toBe('22222');
    expect(socketInode(40001, 39000, proc)).toBeNull();
  });

  it('walks up the parents', async () => {
    const proc = await fakeProc();
    expect(descendsFrom(300, 100, proc)).toBe(true);
    expect(descendsFrom(900, 100, proc)).toBe(false);
  });

  it("accepts a connection from the run's process tree only", async () => {
    const proc = await fakeProc();
    expect(connectionFromRun(40000, 39000, 100, proc)).toBe(true);
    expect(connectionFromRun(40000, 39000, 900, proc)).toBe(false);
  });
});
