import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// Who is on the other end of a loopback connection to the actions server
// (#257): the process that holds the client's socket, found in /proc. The
// server answers only a process of its own run — a descendant of that run's
// `claude` — so another run that got hold of its credential (one prompted
// from the portal, reading the environment of a run of the same repo) can't
// use it. ronin runs as root and sees every process; elsewhere (a runner
// installed by hand) it sees its own user's, which are the agents' too.

const hexPort = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');

// The inode of the client's socket: its line in /proc/net/tcp has the
// client's port as local and the server's as remote, both on 127.0.0.1.
export function socketInode(clientPort: number, serverPort: number, procDir = '/proc'): string | null {
  const local = `0100007F:${hexPort(clientPort)}`;
  const remote = `0100007F:${hexPort(serverPort)}`;
  let table: string;
  try {
    table = readFileSync(join(procDir, 'net', 'tcp'), 'utf8');
  } catch {
    return null;
  }
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] === local && cols[2] === remote) return cols[9] ?? null;
  }
  return null;
}

// The process holding that socket open.
export function pidOfSocket(inode: string, procDir = '/proc'): number | null {
  const target = `socket:[${inode}]`;
  for (const pid of readdirSync(procDir)) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = readdirSync(join(procDir, pid, 'fd'));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(join(procDir, pid, 'fd', fd)) === target) return Number(pid);
      } catch {
        // gone meanwhile
      }
    }
  }
  return null;
}

function parentOf(pid: number, procDir: string): number | null {
  try {
    const stat = readFileSync(join(procDir, String(pid), 'stat'), 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

export function descendsFrom(pid: number, ancestor: number, procDir = '/proc'): boolean {
  for (let current: number | null = pid, steps = 0; current && current > 1 && steps < 64; steps++) {
    if (current === ancestor) return true;
    current = parentOf(current, procDir);
  }
  return false;
}

// Whether the connection from clientPort comes from a process of the run
// rooted at `root`.
export function connectionFromRun(clientPort: number, serverPort: number, root: number, procDir = '/proc'): boolean {
  const inode = socketInode(clientPort, serverPort, procDir);
  const pid = inode ? pidOfSocket(inode, procDir) : null;
  return pid !== null && descendsFrom(pid, root, procDir);
}
