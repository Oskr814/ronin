// Whether a process is still running: signal 0 checks without sending
// anything. EPERM: alive, just not ours to signal.
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Set in the env of an app's own processes (a preview's dev servers, a
// prototype's, an exploration's: domains/product-app/runtime.ts). They aren't
// jobs: the runner's drain doesn't wait for them (apps/api/jobs/drain.ts).
export const APP_PROCESS_ENV = 'RONIN_APP_PROCESS';
