import { describe, it, expect, afterEach } from 'vitest';
import { activeRepo, withActiveRepo } from './repo-context.js';

afterEach(() => {
  delete process.env.WORKTREE_BASE_PATH;
});

describe('activeRepo', () => {
  it('throws when called outside withActiveRepo', () => {
    expect(() => activeRepo()).toThrow('activeRepo() called outside withActiveRepo()');
  });
});

describe('withActiveRepo', () => {
  it('makes the entry readable via activeRepo() while fn runs', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
      expect(activeRepo().productRepo).toBe('a/b');
      expect(activeRepo().productRepoPath).toBe('/tmp/a');
    });
  });

  it('derives worktreeBasePath as a sibling of productRepoPath by default', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a/checkout' }, async () => {
      expect(activeRepo().worktreeBasePath).toBe('/tmp/a/ronin-worktrees');
    });
  });

  it('honors WORKTREE_BASE_PATH as an override', async () => {
    process.env.WORKTREE_BASE_PATH = '/tmp/custom-worktrees';
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a/checkout' }, async () => {
      expect(activeRepo().worktreeBasePath).toBe('/tmp/custom-worktrees');
    });
  });

  it('carries claudeConfigDir through when the entry has one', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: '/home/x/.claude-a' }, async () => {
      expect(activeRepo().claudeConfigDir).toBe('/home/x/.claude-a');
    });
  });

  it('carries worktreeBaseRef through when the entry has one', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a', worktreeBaseRef: 'origin/odoo-main' }, async () => {
      expect(activeRepo().worktreeBaseRef).toBe('origin/odoo-main');
    });
  });

  it('leaves worktreeBaseRef undefined when the entry has none', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
      expect(activeRepo().worktreeBaseRef).toBeUndefined();
    });
  });

  it('resets to null after fn resolves, even when fn throws', async () => {
    await expect(
      withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(() => activeRepo()).toThrow();
  });

  it("returns fn's resolved value", async () => {
    const result = await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => 42);
    expect(result).toBe(42);
  });
});
