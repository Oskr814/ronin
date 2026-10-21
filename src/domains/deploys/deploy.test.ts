import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listReleases = vi.fn();
const createRelease = vi.fn();
const listMergedPrs = vi.fn();
vi.mock('../../core/github.js', () => ({
  listReleases: (...args: unknown[]) => listReleases(...args),
  createRelease: (...args: unknown[]) => createRelease(...args),
  listMergedPrs: (...args: unknown[]) => listMergedPrs(...args),
}));

const listRequests = vi.fn();
const noteEvent = vi.fn();
vi.mock('../portal/requests.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portal/requests.js')>()),
  listRequests: (...args: unknown[]) => listRequests(...args),
  noteEvent: (...args: unknown[]) => noteEvent(...args),
}));

import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { appsOf, pendingChanges, planRelease, prOf, publishRelease, validTag } from './deploy.js';
import { listDeploys } from './store.js';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd })).stdout.trim();

// An origin with a release (v1.0.0) and, after it, three squash-merged PRs:
// #1 and #2 change the same line of a.txt (#2 needs #1), #3 adds b.txt.
let base: string;
let origin: string;
let clone: string;
let entry: RepoEntry;
const release = (tagName: string, publishedAt: string, isPrerelease = false) => ({ tagName, name: tagName, url: '', publishedAt, isDraft: false, isPrerelease });

async function commit(cwd: string, file: string, content: string, subject: string): Promise<void> {
  await mkdir(join(cwd, file, '..'), { recursive: true });
  await writeFile(join(cwd, file), content);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-q', '-m', subject]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(join(tmpdir(), 'ronin-deploy-test-'));
  origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  clone = join(base, 'repo');
  await execFileAsync('git', ['init', '-q', '--bare', origin]);
  await mkdir(seed);
  await git(seed, ['init', '-q', '-b', 'main']);
  await git(seed, ['config', 'user.email', 'dev@example.com']);
  await git(seed, ['config', 'user.name', 'dev']);
  await commit(seed, 'ronin.app.json', JSON.stringify({ apps: { web: { path: 'apps/web' }, api: { path: 'apps/api/' } } }), 'initial');
  await commit(seed, 'apps/web/a.txt', 'uno\n', 'feat: a (#10)');
  await git(seed, ['tag', 'v1.0.0']);
  await commit(seed, 'apps/web/a.txt', 'dos\n', 'feat: a dice dos (#1)');
  await commit(seed, 'apps/web/a.txt', 'tres\n', 'feat: a dice tres (#2)');
  await commit(seed, 'apps/api/b.txt', 'b\n', 'fix: agrega b (#3)');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '-q', 'origin', 'main', '--tags']);
  await execFileAsync('git', ['clone', '-q', origin, clone]);
  entry = { productRepo: 'acme/app', productRepoPath: clone, worktreeBaseRef: 'origin/main', deploy: { selective: true } };
  listReleases.mockResolvedValue([release('v1.0.0', '2026-10-01T00:00:00Z')]);
  listRequests.mockResolvedValue([{ number: 7, repo: 'acme/app', pr: 3 }, { number: 8, repo: 'otro/repo', pr: 3 }]);
  createRelease.mockResolvedValue('https://github.com/acme/app/releases/tag/x');
  noteEvent.mockResolvedValue(undefined);
  listMergedPrs.mockResolvedValue([]);
});

afterEach(async () => {
  // A git process can still be writing under it (ENOTEMPTY once in the CI): retried.
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const inRepo = <T>(fn: () => Promise<T>) => withActiveRepo(entry, fn);

describe('pendingChanges', () => {
  it('lists what the branch has after the last release, oldest first, with its PR, apps and requests', async () => {
    const pending = await inRepo(() => pendingChanges());
    expect(pending.base?.tag).toBe('v1.0.0');
    expect(pending.changes.map((c) => [c.pr, c.apps, c.pedidos])).toEqual([[1, ['web'], []], [2, ['web'], []], [3, ['api'], [7]]]);
    expect(pending.changes[2].files).toEqual(['apps/api/b.txt']);
  });

  it('compares a pre-release with the last pre-release', async () => {
    listReleases.mockResolvedValue([release('v1.0.0', '2026-10-01T00:00:00Z')]);
    expect((await inRepo(() => pendingChanges({ prerelease: true }))).base).toBeNull();
  });
});

describe('planRelease', () => {
  it('carries everything on the branch, on its head', async () => {
    const plan = await inRepo(() => planRelease({ tag: 'v1.1.0', prs: 'all' }));
    expect(plan.problems).toEqual([]);
    expect(plan.target).toBe(await git(clone, ['rev-parse', 'origin/main']));
    expect(plan.apps.sort()).toEqual(['api', 'web']);
    expect(plan.notes).toContain('- fix: agrega b (#3) · pedido P-7');
  });

  it('refuses a tag that exists or that git or a URL would choke on', async () => {
    expect((await inRepo(() => planRelease({ tag: 'v1.0.0', prs: 'all' }))).problems).toEqual([{ kind: 'tag-exists' }]);
    expect((await inRepo(() => planRelease({ tag: 'v1 .1', prs: 'all' }))).problems).toEqual([{ kind: 'tag-invalid' }]);
  });

  it('carries only the picked PR, cherry-picked onto the last release', async () => {
    const plan = await inRepo(() => planRelease({ tag: 'v1.0.1', prs: [3] }));
    expect(plan.problems).toEqual([]);
    expect(plan.changes.map((c) => c.pr)).toEqual([3]);
    expect(await git(clone, ['show', `${plan.target}:apps/api/b.txt`])).toBe('b');
    expect(await git(clone, ['show', `${plan.target}:apps/web/a.txt`])).toBe('uno');
    expect(await git(clone, ['rev-parse', `${plan.target}~1`])).toBe(await git(clone, ['rev-parse', 'v1.0.0']));
  });

  it('says which picked PR does not apply and which one it needs', async () => {
    const plan = await inRepo(() => planRelease({ tag: 'v1.0.1', prs: [2, 3] }));
    expect(plan.target).toBeNull();
    expect(plan.problems).toEqual([{ kind: 'conflict', pr: 2, sha: plan.changes[0].sha, files: ['apps/web/a.txt'], needs: [1] }]);
  });

  it('refuses picked PRs in a repo without deploy.selective, and a PR not pending', async () => {
    entry.deploy = {};
    expect((await inRepo(() => planRelease({ tag: 'v1.0.1', prs: [3] }))).problems).toContainEqual({ kind: 'not-selective' });
    entry.deploy = { selective: true };
    expect((await inRepo(() => planRelease({ tag: 'v1.0.1', prs: [10] }))).problems).toContainEqual({ kind: 'unknown-pr', pr: 10 });
  });

  it('refuses a pre-release in a repo that does not use them', async () => {
    await expect(inRepo(() => planRelease({ tag: 'rc1', prs: 'all', prerelease: true }))).rejects.toThrow(/no usa pre-releases/);
  });
});

describe('publishRelease', () => {
  it('pushes the tag, creates the release on it, records it and notes it on its requests', async () => {
    const record = await inRepo(() => publishRelease({ tag: 'v1.0.1', prs: [3], by: 'persona' }));
    const tagged = (await git(origin, ['rev-parse', 'refs/tags/v1.0.1^{commit}']));
    expect(record).toMatchObject({ repo: 'acme/app', tag: 'v1.0.1', mode: 'pick', base: 'v1.0.0', sha: tagged, pedidos: [7], by: 'persona', state: 'running' });
    expect(createRelease).toHaveBeenCalledWith({ tag: 'v1.0.1', title: 'v1.0.1', notes: expect.stringContaining('(#3)'), prerelease: false });
    expect(await listDeploys('acme/app')).toEqual([record]);
    expect(noteEvent).toHaveBeenCalledWith(7, { kind: 'deploy', tag: 'v1.0.1', state: 'published', prerelease: false });
  });

  it('does not list again a PR that went out in a release of picked PRs', async () => {
    await inRepo(() => publishRelease({ tag: 'v1.0.1', prs: [3], by: 'persona' }));
    listReleases.mockResolvedValue([release('v1.0.0', '2026-10-01T00:00:00Z'), release('v1.0.1', '2026-10-02T00:00:00Z')]);
    const pending = await inRepo(() => pendingChanges());
    expect(pending.base?.tag).toBe('v1.0.1');
    expect(pending.changes.map((c) => c.pr)).toEqual([1, 2]);
  });

  it('refuses when what goes in changed since it was planned', async () => {
    const plan = await inRepo(() => planRelease({ tag: 'v1.1.0', prs: 'all' }));
    const seed = join(base, 'seed');
    await commit(seed, 'apps/web/c.txt', 'c\n', 'feat: c (#4)');
    await git(seed, ['push', '-q', 'origin', 'main']);
    await expect(inRepo(() => publishRelease({ tag: 'v1.1.0', prs: 'all', by: 'persona', fingerprint: plan.fingerprint }))).rejects.toThrow(/cambió desde que lo viste/);
    expect(createRelease).not.toHaveBeenCalled();
  });

  it('keeps the record when the tag went up but the release failed', async () => {
    createRelease.mockRejectedValue(new Error('HTTP 502'));
    await expect(inRepo(() => publishRelease({ tag: 'v1.1.0', prs: 'all', by: 'persona' }))).rejects.toThrow(/Se subió el tag v1.1.0/);
    expect((await listDeploys('acme/app'))[0]).toMatchObject({ tag: 'v1.1.0', releaseError: 'HTTP 502', state: 'running' });
  });
});

// A repo that merges PRs with a merge commit named after the PR's title,
// without its number: GitHub says which PR each merge commit is.
describe('a repo with merge commits', () => {
  beforeEach(async () => {
    const seed = join(base, 'seed');
    for (const [branch, file, n] of [['feat/d', 'apps/web/d.txt', 4], ['feat/e', 'apps/api/e.txt', 5]] as const) {
      await git(seed, ['checkout', '-q', '-b', branch, 'main']);
      await commit(seed, file, 'uno\n', `wip ${n}`);
      await commit(seed, file, 'dos\n', `wip ${n} bis`);
      await git(seed, ['checkout', '-q', 'main']);
      await git(seed, ['merge', '-q', '--no-ff', '-m', `feat: el cambio ${n}`, branch]);
    }
    await git(seed, ['push', '-q', 'origin', 'main']);
    const merges = (await git(seed, ['rev-list', '--first-parent', '-2', 'main'])).split('\n');
    listMergedPrs.mockResolvedValue([{ number: 5, title: 'Cambio cinco', mergeCommit: merges[0] }, { number: 4, title: 'Cambio cuatro', mergeCommit: merges[1] }]);
  });

  it('lists one change per PR, by its merge commit, with the PR GitHub knows', async () => {
    const pending = await inRepo(() => pendingChanges());
    expect(pending.changes.map((c) => [c.pr, c.subject, c.files])).toEqual([
      [1, 'feat: a dice dos (#1)', ['apps/web/a.txt']], [2, 'feat: a dice tres (#2)', ['apps/web/a.txt']], [3, 'fix: agrega b (#3)', ['apps/api/b.txt']],
      [4, 'Cambio cuatro (#4)', ['apps/web/d.txt']], [5, 'Cambio cinco (#5)', ['apps/api/e.txt']],
    ]);
  });

  it('picks a merged PR whole, and does not list it again after its release', async () => {
    const plan = await inRepo(() => planRelease({ tag: 'v1.0.1', prs: [5] }));
    expect(plan.problems).toEqual([]);
    expect(await git(clone, ['show', `${plan.target}:apps/api/e.txt`])).toBe('dos');
    await inRepo(() => publishRelease({ tag: 'v1.0.1', prs: [5], by: 'persona' }));
    listReleases.mockResolvedValue([release('v1.0.0', '2026-10-01T00:00:00Z'), release('v1.0.1', '2026-10-02T00:00:00Z')]);
    expect((await inRepo(() => pendingChanges())).changes.map((c) => c.pr)).toEqual([1, 2, 3, 4]);
    // And another picked release on top of that one still leaves both out.
    await inRepo(() => publishRelease({ tag: 'v1.0.2', prs: [3], by: 'persona' }));
    listReleases.mockResolvedValue([release('v1.0.1', '2026-10-02T00:00:00Z'), release('v1.0.2', '2026-10-03T00:00:00Z')]);
    expect((await inRepo(() => pendingChanges())).changes.map((c) => c.pr)).toEqual([1, 2, 4]);
  });
});

describe('helpers', () => {
  it('reads the PR of a squash or a merge commit', () => {
    expect(prOf('fix: algo (#123)')).toBe(123);
    expect(prOf('Merge pull request #45 from acme/rama')).toBe(45);
    expect(prOf('chore: sin PR')).toBeNull();
  });

  it('knows the apps a file is in', () => {
    expect(appsOf(['apps/web/x.ts', 'packages/y.ts'], { web: 'apps/web', webx: 'apps/webx' })).toEqual(['web']);
  });

  it('takes tags GitHub and git take', () => {
    expect(['v1.2.3', 'rc20261018', 'v20261018-b'].every(validTag)).toBe(true);
    expect(['', '-v1', 'v1..2', 'v1.lock', 'a/b', 'v1 2'].some(validTag)).toBe(false);
  });
});
