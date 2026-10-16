import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ worktreeBasePath: base }) }));

const { tryLockResource, unlockResource, withResourceLock, pinResources, unpinResources, withSlots } = await import('./locks.js');

const lockFile = (resource: string) => join(base, '.locks', `${resource}.lock`);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-locks-'));
  vi.spyOn(process, 'cwd').mockReturnValue(base);
});

afterEach(async () => {
  await unpinResources();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe('tryLockResource', () => {
  it('lets one job of the process hold a resource at a time', async () => {
    expect(await tryLockResource('issue-1')).toBe(true);
    expect(await tryLockResource('issue-1')).toBe(false);
    await unlockResource('issue-1');
    expect(existsSync(lockFile('issue-1'))).toBe(false);
    expect(await tryLockResource('issue-1')).toBe(true);
    await unlockResource('issue-1');
  });

  it('respects a lock held by another live process, and takes over one left by a dead one', async () => {
    await mkdir(join(base, '.locks'), { recursive: true });
    await writeFile(lockFile('pr-2'), String(process.ppid));
    expect(await tryLockResource('pr-2')).toBe(false);

    await writeFile(lockFile('pr-2'), '999999999');
    expect(await tryLockResource('pr-2')).toBe(true);
    await unlockResource('pr-2');
  });
});

describe('withResourceLock', () => {
  it("skips fn when the resource is taken, in 'skip' mode", async () => {
    await tryLockResource('issue-3');
    const fn = vi.fn(async () => {});
    expect(await withResourceLock('issue-3', 'skip', fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    await unlockResource('issue-3');
  });

  it('releases the resource even when fn throws', async () => {
    await expect(withResourceLock('issue-4', 'wait', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockFile('issue-4'))).toBe(false);
  });
});

describe('pinResources', () => {
  it("hands a pinned resource to the handler's own jobs, and keeps it until unpinned", async () => {
    await pinResources(['pr-5', 'issue-5']);
    expect(await tryLockResource('issue-5')).toBe(true);
    await unlockResource('issue-5');
    expect(existsSync(lockFile('issue-5'))).toBe(true);

    await unpinResources();
    expect(existsSync(lockFile('issue-5'))).toBe(false);
    expect(existsSync(lockFile('pr-5'))).toBe(false);
  });
});

describe('withSlots', () => {
  it('never runs more than `limit` at once', async () => {
    let running = 0;
    let peak = 0;
    const job = () => withSlots('issue', 1, {}, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
    });
    await Promise.all([job(), job()]);
    expect(peak).toBe(1);
  });

  it("returns fn's result and frees its slots", async () => {
    expect(await withSlots('changelog', 2, { changelog: 1 }, async () => 7)).toBe(7);
    expect(existsSync(join(base, '.ronin-slots', 'all-0.lock'))).toBe(false);
    expect(existsSync(join(base, '.ronin-slots', 'kind-changelog-0.lock'))).toBe(false);
  });
});
