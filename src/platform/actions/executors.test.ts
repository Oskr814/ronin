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
const getPullRequestStatus = vi.fn();
const setPullRequestBody = vi.fn();
const createPullRequest = vi.fn(async (..._args: unknown[]) => 51);
const addIssueAssignees = vi.fn();
const getIssueBody = vi.fn();
const setIssueBody = vi.fn();
vi.mock('../github/github.js', () => ({
  createPullRequest: (...args: unknown[]) => createPullRequest(...args),
  addIssueAssignees: (...args: unknown[]) => addIssueAssignees(...args),
  getIssueBody: (...args: unknown[]) => getIssueBody(...args),
  setIssueBody: (...args: unknown[]) => setIssueBody(...args),
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
  setPullRequestBody: (...args: unknown[]) => setPullRequestBody(...args),
  replyToComment: (...args: unknown[]) => replyToComment(...args),
  postIssueComment: (...args: unknown[]) => postIssueComment(...args),
  resolveReviewThread: (...args: unknown[]) => resolveReviewThread(...args),
}));

const { executeAction, rootCheckout, bodyKeepsWhatItMust } = await import('./executors.js');
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

describe('pr.update-body', () => {
  const current = 'Closes #228\n\n## Qué cambió\nAntes.\n\n<!-- ronin:help -->\n<sub>ayuda</sub>\n';

  it('keeps the issue link and the help footer', () => {
    expect(bodyKeepsWhatItMust(current, 'Closes #228\n\n## Qué cambió\nDespués.\n\n<!-- ronin:help -->\n<sub>ayuda</sub>')).toBeNull();
    expect(bodyKeepsWhatItMust(current, '## Qué cambió\nDespués.\n\n<!-- ronin:help -->\n<sub>ayuda</sub>')).toContain('Closes #228');
    expect(bodyKeepsWhatItMust(current, 'Closes #228\n\nDespués.\n\n<!-- ronin:help -->\n<sub>otra</sub>')).toContain('ronin:help');
    expect(bodyKeepsWhatItMust('Sin issue ni pie', 'Otra cosa')).toBeNull();
  });

  it('closes no issue the current one does not', () => {
    expect(bodyKeepsWhatItMust('Parte de #9\n\nAntes.', 'Closes #9\n\nDespués.')).toContain('#9');
    expect(bodyKeepsWhatItMust(current, 'Closes #228\n\nY fixes #3\n\n<!-- ronin:help -->\n<sub>ayuda</sub>')).toContain('#3');
  });

  it('saves it only when it does', async () => {
    const { scope, checkout } = await setup();
    getPullRequestStatus.mockResolvedValue({ body: current });

    await expect(executeAction(scope, checkout, { name: 'pr.update-body', input: { body: 'Todo nuevo' } })).rejects.toBeInstanceOf(ActionRefused);
    expect(setPullRequestBody).not.toHaveBeenCalled();

    const next = 'Closes #228\n\n## Qué cambió\nDespués.\n\n<!-- ronin:help -->\n<sub>ayuda</sub>';
    await executeAction(scope, checkout, { name: 'pr.update-body', input: { body: next } });
    expect(setPullRequestBody).toHaveBeenCalledWith(7, next);
  });
});

describe('git.push on its own branch', () => {
  // A new branch for a slice: built on origin's main, nothing on origin yet.
  async function ownBranch() {
    const t = await setup();
    const base = await git(t.repo, 'rev-parse', 'origin/main').catch(async () => {
      await git(t.repo, 'push', '-q', 'origin', 'HEAD~1:refs/heads/main');
      await git(t.repo, 'fetch', '-q', 'origin');
      return git(t.repo, 'rev-parse', 'origin/main');
    });
    await git(t.clone, 'fetch', '-q', 'origin');
    await git(t.clone, 'checkout', '-q', '-B', 'ronin/9/slice-1', base);
    const scope: RunScope = { ...t.scope, headRef: 'ronin/9/slice-1', startSha: base, push: { mode: 'branch', baseSha: base, remoteSha: null }, allowed: ['git.push', 'pr.create'], pr: { base: 'main', draft: false, closes: 9 } };
    return { ...t, base, scope };
  }

  it('pushes whatever it built on its base, and only if the branch is still as it found it', async () => {
    const { origin, clone, scope, checkout } = await ownBranch();
    await writeFile(join(clone, 'b.txt'), 'uno\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'slice');
    const head = await git(clone, 'rev-parse', 'HEAD');

    expect(await executeAction(scope, checkout, { name: 'git.push', input: {} })).toEqual({ sha: head });
    expect(await git(origin, 'rev-parse', 'refs/heads/ronin/9/slice-1')).toBe(head);

    // The scope still says the branch wasn't there: a second push, with
    // something on origin it didn't account for, is refused.
    await writeFile(join(clone, 'b.txt'), 'dos\n');
    await git(clone, 'commit', '-qam', 'otra');
    await expect(executeAction(scope, checkout, { name: 'git.push', input: {} })).rejects.toThrow('alguien subió otro commit');
  });

  it('refuses a branch rebuilt somewhere other than its base', async () => {
    const { clone, scope, checkout, startSha } = await ownBranch();
    await git(clone, 'checkout', '-q', '--orphan', 'otra');
    await writeFile(join(clone, 'c.txt'), 'x\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'sin base');
    expect(startSha).toBeTruthy();
    await expect(executeAction(scope, checkout, { name: 'git.push', input: {} })).rejects.toBeInstanceOf(ActionRefused);
  });

  it('opens the PR only once the branch is on origin, with the base and assignee ronin chose', async () => {
    const { clone, scope, checkout } = await ownBranch();
    const pr = { name: 'pr.create' as const, input: { title: 'Slice 1', body: 'Closes #9\n\nCuerpo' } };
    await expect(executeAction(scope, checkout, pr)).rejects.toThrow('súbela con git.push');

    await writeFile(join(clone, 'b.txt'), 'uno\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'slice');
    await executeAction(scope, checkout, { name: 'git.push', input: {} });
    expect(await executeAction({ ...scope, pr: { ...scope.pr!, draft: true, assignee: 'ronin-agent' } }, checkout, pr)).toEqual({ number: 51 });
    expect(createPullRequest).toHaveBeenCalledWith({ head: 'ronin/9/slice-1', base: 'main', title: 'Slice 1', body: 'Closes #9\n\nCuerpo', draft: true });
    expect(addIssueAssignees).toHaveBeenCalledWith(51, ['ronin-agent']);
  });
});

describe('git.push fast-forward', () => {
  it('pushes new commits on top, and refuses rewriting what was there', async () => {
    const { origin, clone, scope: base, checkout } = await setup();
    const scope: RunScope = { ...base, push: { mode: 'fast-forward' } };
    await writeFile(join(clone, 'a.txt'), 'base\nfeat\nmás\n');
    await git(clone, 'commit', '-qam', 'cambio del spec');
    const head = await git(clone, 'rev-parse', 'HEAD');
    expect(await executeAction(scope, checkout, { name: 'git.push', input: {} })).toEqual({ sha: head });
    expect(await git(origin, 'rev-parse', 'refs/heads/feat/x')).toBe(head);

    const { clone: clone2, scope: base2, checkout: checkout2 } = await setup();
    await writeFile(join(clone2, 'a.txt'), 'reescrito\n');
    await git(clone2, 'commit', '-q', '-a', '--amend', '--no-edit');
    await expect(executeAction({ ...base2, push: { mode: 'fast-forward' } }, checkout2, { name: 'git.push', input: {} })).rejects.toThrow('solo commits nuevos');
  });
});

describe('issue actions', () => {
  it('comments on the run\'s issue, and replaces or appends to its body as the run allows', async () => {
    const { checkout, scope } = await setup();
    getIssueBody.mockResolvedValue('Lo de antes\n');
    await executeAction({ ...scope, issue: { number: 9, body: 'append' } }, checkout, { name: 'issue.update-body', input: { body: '## Spike\nHallazgos' } });
    expect(setIssueBody).toHaveBeenLastCalledWith(9, 'Lo de antes\n\n## Spike\nHallazgos');
    await executeAction({ ...scope, issue: { number: 9, body: 'replace' } }, checkout, { name: 'issue.update-body', input: { body: '- [ ] Slice 1: algo — PR: _pending_' } });
    expect(setIssueBody).toHaveBeenLastCalledWith(9, '- [ ] Slice 1: algo — PR: _pending_');
  });
});

describe('git.push from a worktree', () => {
  // A runner without agent users works in worktrees, whose .git is a file.
  it('writes its bundle where git keeps the worktree, and pushes', async () => {
    const { origin, repo, startSha, scope } = await setup();
    const wt = join(repo, '..', 'wt');
    await git(repo, 'worktree', 'add', '-q', '--detach', wt, startSha);
    await writeFile(join(wt, 'a.txt'), 'base\nfeat desde un worktree\n');
    await git(wt, 'commit', '-q', '-a', '--amend', '--no-edit');
    const amended = await git(wt, 'rev-parse', 'HEAD');

    expect(await executeAction(scope, rootCheckout(wt, repo), { name: 'git.push', input: {} })).toEqual({ sha: amended });
    expect(await git(origin, 'rev-parse', 'refs/heads/feat/x')).toBe(amended);
  });
});
