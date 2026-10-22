import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunScope } from './catalog.js';

const replyToComment = vi.fn();
const postIssueComment = vi.fn();
const resolveReviewThread = vi.fn();
vi.mock('../github/github.js', () => ({
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  resolveReviewThread: (...args: unknown[]) => resolveReviewThread(...args),
}));

const exec = vi.fn();
vi.mock('../host/host.js', () => ({ host: () => ({ exec: (...args: unknown[]) => exec(...args) }) }));

const { executeAction } = await import('./executors.js');
const { ActionRefused } = await import('./catalog.js');

const scope: RunScope = {
  prNumber: 7,
  headRef: 'feat/x',
  startSha: 'start',
  threads: [{ commentId: 100, threadId: 'PRRT_a' }],
  triggers: [],
  allowed: ['pr.reply', 'pr.resolve-thread', 'git.push'],
};

beforeEach(() => {
  vi.clearAllMocks();
  exec.mockImplementation(async (_file: string, args: string[]) => ({ stdout: args[0] === 'rev-parse' ? 'amended\n' : '', stderr: '' }));
});

describe('executeAction', () => {
  it('replies in the thread and resolves it by its GraphQL id', async () => {
    await executeAction(scope, '/w', { name: 'pr.reply', input: { commentId: 100, body: 'Hecho.' } });
    await executeAction(scope, '/w', { name: 'pr.resolve-thread', input: { commentId: 100 } });
    expect(replyToComment).toHaveBeenCalledWith(7, { id: 100, kind: 'review' }, 'Hecho.');
    expect(resolveReviewThread).toHaveBeenCalledWith('PRRT_a');
  });

  it('pushes to the branch, leased on the commit the run started from', async () => {
    expect(await executeAction(scope, '/w', { name: 'git.push', input: {} })).toEqual({ sha: 'amended' });
    expect(exec).toHaveBeenCalledWith('git', ['push', '--force-with-lease=refs/heads/feat/x:start', 'origin', 'HEAD:refs/heads/feat/x'], { cwd: '/w' });
  });

  it("tells the agent when someone else pushed meanwhile", async () => {
    exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === 'push') throw Object.assign(new Error('push failed'), { stderr: '! [rejected] HEAD -> feat/x (stale info)' });
      return { stdout: 'amended', stderr: '' };
    });
    await expect(executeAction(scope, '/w', { name: 'git.push', input: {} })).rejects.toBeInstanceOf(ActionRefused);
  });
});
