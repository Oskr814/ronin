import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunScope } from './catalog.js';

const replyToComment = vi.fn();
const postIssueComment = vi.fn();
const resolveReviewThread = vi.fn();
vi.mock('../github/github.js', () => ({
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  resolveReviewThread: (...args: unknown[]) => resolveReviewThread(...args),
}));

const { executeAction, rootCheckout } = await import('./executors.js');
const { ActionRefused } = await import('./catalog.js');

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

// GitHub as a bare repo, ronin's shared clone of it, and the run's own
// clone of that one (--shared, as ensureAgentClone makes it), with the PR's
// branch at "start".
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ronin-exec-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const clone = join(root, 'clone');
  await run('git', ['init', '-q', '--bare', origin]);
  await run('git', ['clone', '-q', origin, repo]);
  for (const [k, v] of [['user.name', 'ronin'], ['user.email', 'ronin@example.com']]) await git(repo, 'config', k, v);
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'base');
  await git(repo, 'checkout', '-qb', 'feat/x');
  await writeFile(join(repo, 'a.txt'), 'base\nfeat\n');
  await git(repo, 'commit', '-qam', 'feat');
  await git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/x');
  const startSha = await git(repo, 'rev-parse', 'HEAD');
  await run('git', ['clone', '-q', '--shared', repo, clone]);
  for (const [k, v] of [['user.name', 'agent'], ['user.email', 'agent@example.com']]) await git(clone, 'config', k, v);
  await git(clone, 'checkout', '-q', '--detach', startSha);
  const scope: RunScope = { prNumber: 7, headRef: 'feat/x', startSha, threads: [{ commentId: 100, threadId: 'PRRT_a' }], triggers: [], allowed: ['git.push'] };
  return { origin, repo, clone, startSha, scope, checkout: rootCheckout(clone, repo) };
}

beforeEach(() => vi.clearAllMocks());

describe('executeAction', () => {
  it('replies in the thread and resolves it by its GraphQL id', async () => {
    const { scope, checkout } = await setup();
    await executeAction(scope, checkout, { name: 'pr.reply', input: { commentId: 100, body: 'Hecho.' } });
    await executeAction(scope, checkout, { name: 'pr.resolve-thread', input: { commentId: 100 } });
    expect(replyToComment).toHaveBeenCalledWith(7, { id: 100, kind: 'review' }, 'Hecho.');
    expect(resolveReviewThread).toHaveBeenCalledWith('PRRT_a');
  });

  it("pushes the clone's amend from the shared repo, through a bundle", async () => {
    const { origin, clone, scope, checkout } = await setup();
    await writeFile(join(clone, 'a.txt'), 'base\nfeat arreglado\n');
    await git(clone, 'commit', '-q', '-a', '--amend', '--no-edit');
    const amended = await git(clone, 'rev-parse', 'HEAD');

    expect(await executeAction(scope, checkout, { name: 'git.push', input: {} })).toEqual({ sha: amended });
    expect(await git(origin, 'rev-parse', 'refs/heads/feat/x')).toBe(amended);
  });

  it('refuses a new commit on top, even after the action was validated', async () => {
    const { origin, clone, scope, startSha, checkout } = await setup();
    await writeFile(join(clone, 'b.txt'), 'otro\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'nuevo');

    await expect(executeAction(scope, checkout, { name: 'git.push', input: {} })).rejects.toBeInstanceOf(ActionRefused);
    expect(await git(origin, 'rev-parse', 'refs/heads/feat/x')).toBe(startSha);
  });

  it('tells the agent when someone else pushed meanwhile, and leaves their work', async () => {
    const { origin, repo, clone, scope, checkout } = await setup();
    await writeFile(join(repo, 'a.txt'), 'base\nde una persona\n');
    await git(repo, 'commit', '-qam', 'persona');
    await git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/x');
    const theirs = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'fetch', '-q', 'origin');
    await writeFile(join(clone, 'a.txt'), 'base\nfeat arreglado\n');
    await git(clone, 'commit', '-q', '-a', '--amend', '--no-edit');

    await expect(executeAction(scope, checkout, { name: 'git.push', input: {} })).rejects.toThrow('alguien subió otro commit');
    expect(await git(origin, 'rev-parse', 'refs/heads/feat/x')).toBe(theirs);
  });
});
