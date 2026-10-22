import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PROCESS_ENV } from '@platform/workers/process.js';

// What the runner waits for before it goes (#325): every process of its
// container besides itself — the jobs it started, the agents and workers
// those started in turn, each in its own session. The API's processes share
// the PID namespace (compose.yml) but not the cgroup, which Docker gives each
// container: that's what tells them apart. Not an app's own processes (a
// preview's dev servers, marked with APP_PROCESS_ENV): they run until the
// preview goes, an hour, and aren't work to finish. They go with the runner,
// and the preview with them.

// One process: its parent and its state, from /proc/<pid>/stat. The name
// (between parentheses) may have spaces and parentheses itself.
function statOf(procDir: string, pid: string): { ppid: number; state: string } | null {
  try {
    const stat = readFileSync(join(procDir, pid, 'stat'), 'utf8');
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(ppid), state };
  } catch {
    return null;
  }
}

// Whether its env has the app mark. One that can't be read counts as not:
// waiting for it is the safe side.
function isApp(procDir: string, pid: string): boolean {
  try {
    return readFileSync(join(procDir, pid, 'environ'), 'utf8').split('\0').includes(`${APP_PROCESS_ENV}=1`);
  } catch {
    return false;
  }
}

const cgroupOf = (procDir: string, pid: string): string | null => {
  try {
    return readFileSync(join(procDir, pid, 'cgroup'), 'utf8');
  } catch {
    return null;
  }
};

// The pids still alive in this process's cgroup: not itself, not the
// container's init, not a zombie, not a `docker exec` (no parent in the
// namespace) someone has open, and not an app's.
export function busyProcesses(procDir = '/proc', self = process.pid): number[] {
  const own = cgroupOf(procDir, String(self));
  if (own === null) return [];
  const init = statOf(procDir, String(self))?.ppid;
  const busy: number[] = [];
  for (const pid of readdirSync(procDir)) {
    if (!/^\d+$/.test(pid) || Number(pid) === self || Number(pid) === init) continue;
    const stat = statOf(procDir, pid);
    if (!stat || stat.state === 'Z' || stat.ppid === 0) continue;
    if (cgroupOf(procDir, pid) === own && !isApp(procDir, pid)) busy.push(Number(pid));
  }
  return busy;
}

// Resolves once nothing of the container is left running, saying every
// `reportEveryMs` how many still are. Whatever Docker's grace period
// (stop_grace_period) doesn't leave room for is cut, as before.
export async function drain(report: (busy: number) => void, { pollMs = 5000, reportEveryMs = 60_000, busy = () => busyProcesses().length } = {}): Promise<void> {
  let reported = 0;
  for (let left = busy(); left > 0; left = busy()) {
    if (Date.now() - reported >= reportEveryMs) {
      report(left);
      reported = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
