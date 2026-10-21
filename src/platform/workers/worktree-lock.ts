import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { activeRepo } from '../agents/repo-context.js';
import { acquireLock, lockHeld } from './worker-launch.js';

// A worker's lock in the active repo's worktree directory
// (<worktreeBasePath>/.<name>.lock): one preview per PR, one prototype per
// repo… Held while the process that took it lives (acquireLock).
export function worktreeLock(name: string) {
  const path = () => join(activeRepo().worktreeBasePath, `.${name}.lock`);
  return {
    busy: (): Promise<boolean> => lockHeld(path()),
    acquire: (): Promise<boolean> => acquireLock(path()),
    release: async (): Promise<void> => {
      await rm(path(), { force: true });
    },
    // Waits its turn instead of giving up. `onWait` runs once, when the lock
    // is taken and it starts waiting. False if the time ran out.
    async wait(opts: { intervalMs?: number; timeoutMs?: number; onWait?: () => void | Promise<void> } = {}): Promise<boolean> {
      const intervalMs = opts.intervalMs ?? 30_000;
      const deadline = Date.now() + (opts.timeoutMs ?? 3 * 60 * 60_000);
      for (let waited = false; ; waited = true) {
        if (await acquireLock(path())) return true;
        if (Date.now() >= deadline) return false;
        if (!waited) await opts.onWait?.();
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
}
