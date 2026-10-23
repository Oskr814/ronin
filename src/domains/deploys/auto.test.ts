import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listReleases = vi.fn();
const createRelease = vi.fn();
const listMergedPrs = vi.fn();
vi.mock('@platform/github/github.js', () => ({
  listReleases: (...args: unknown[]) => listReleases(...args),
  createRelease: (...args: unknown[]) => createRelease(...args),
  listMergedPrs: (...args: unknown[]) => listMergedPrs(...args),
}));
vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));
vi.mock('@platform/notify/notifications.js', () => ({ recipientsFor: async () => 'equipo@example.com' }));
let autoState: { at: string; problem: string | null; tag?: string } | undefined;
vi.mock('@platform/state/local-state.js', () => ({
  getAutoDeploy: async () => autoState,
  setAutoDeploy: async (next: typeof autoState) => { autoState = { ...next!, ...(next!.tag ?? autoState?.tag ? { tag: next!.tag ?? autoState?.tag } : {}) }; },
}));

// Invented requests: P-7 is PR #3 (applies), P-9 is PR #2 (needs #1, not a request's).
type Req = { number: number; repo: string; pr: number; status: string; events: Array<Record<string, unknown>>; deployed?: unknown };
let requests: Req[];
vi.mock('../portal/requests.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portal/requests.js')>()),
  listRequests: async () => requests,
  noteEvent: async () => {},
  updateRequest: async (n: number, fn: (r: Req) => void) => fn(requests.find((r) => r.number === n)!),
}));

import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import { autoDeploy } from './auto.js';
import { listDeploys } from './store.js';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd })).stdout.trim();
const release = (tagName: string) => ({ tagName, name: tagName, url: '', publishedAt: '2026-10-01T00:00:00Z', isDraft: false, isPrerelease: false });

let base: string;
let origin: string;
let entry: RepoEntry;

async function commit(cwd: string, file: string, content: string, subject: string): Promise<void> {
  await mkdir(join(cwd, file, '..'), { recursive: true });
  await writeFile(join(cwd, file), content);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-q', '-m', subject]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  autoState = undefined;
  base = await mkdtemp(join(tmpdir(), 'ronin-auto-deploy-test-'));
  origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  const clone = join(base, 'repo');
  await execFileAsync('git', ['init', '-q', '--bare', origin]);
  await mkdir(seed);
  await git(seed, ['init', '-q', '-b', 'main']);
  await git(seed, ['config', 'user.email', 'dev@example.com']);
  await git(seed, ['config', 'user.name', 'dev']);
  await commit(seed, 'a.txt', 'uno\n', 'initial');
  await git(seed, ['tag', 'v1.4.7']);
  await commit(seed, 'a.txt', 'dos\n', 'feat: a dice dos (#1)');
  await commit(seed, 'a.txt', 'tres\n', 'feat: a dice tres (#2)');
  await commit(seed, 'b.txt', 'b\n', 'fix: agrega b (#3)');
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '-q', 'origin', 'main', '--tags']);
  await execFileAsync('git', ['clone', '-q', origin, clone]);
  entry = { productRepo: 'acme/app', productRepoPath: clone, worktreeBaseRef: 'origin/main', deploy: { selective: true, auto: { tag: 'v{major}.{minor}.{patch+1}' } } };
  requests = [
    { number: 7, repo: 'acme/app', pr: 3, status: 'done', events: [] },
    { number: 9, repo: 'acme/app', pr: 2, status: 'done', events: [] },
  ];
  listReleases.mockResolvedValue([release('v1.4.7')]);
  listMergedPrs.mockResolvedValue([]);
  createRelease.mockResolvedValue('https://github.com/acme/app/releases/tag/v1.4.8');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const run = () => withActiveRepo(entry, () => autoDeploy(new Date('2026-10-22T15:00:00Z')));

describe('the automatic deploy of the requests (#353)', () => {
  it("publishes the requests' PRs that apply, leaves out the one that doesn't (once), and nothing else", async () => {
    await run();
    expect(createRelease).toHaveBeenCalledOnce();
    expect(createRelease.mock.calls[0][0]).toMatchObject({ tag: 'v1.4.8', prerelease: false });
    expect(await git(origin, ['show', 'v1.4.8:b.txt'])).toBe('b');
    expect(await git(origin, ['show', 'v1.4.8:a.txt'])).toBe('uno');
    const [record] = await listDeploys('acme/app');
    expect(record).toMatchObject({ tag: 'v1.4.8', mode: 'pick', pedidos: [7], prerelease: false });
    expect(autoState).toMatchObject({ problem: null, tag: 'v1.4.8' });
    // P-9's PR needs #1, which isn't a request's: out, said on it and to the team.
    expect(requests[1].events).toEqual([expect.objectContaining({ kind: 'deploy-skipped', base: 'v1.4.7', files: ['a.txt'], needs: [1] })]);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'equipo@example.com', subject: expect.stringContaining('PR #2 quedó fuera') });
  });

  it("costs nothing when no request's merged PR is waiting", async () => {
    requests = [{ number: 7, repo: 'acme/app', pr: 3, status: 'done', events: [{ kind: 'deploy', tag: 'v1.4.8', state: 'deployed', prerelease: false }] }];
    await run();
    expect(listReleases).not.toHaveBeenCalled();
    expect(createRelease).not.toHaveBeenCalled();
  });

  it("doesn't deploy when the last release doesn't fit the pattern, and says why", async () => {
    await git(origin, ['tag', 'release-42', 'v1.4.7']);
    listReleases.mockResolvedValue([release('release-42')]);
    await run();
    expect(createRelease).not.toHaveBeenCalled();
    expect(autoState?.problem).toMatch(/no encaja con el patrón/);
  });

  it('needs deploy.selective', async () => {
    entry.deploy = { auto: { tag: 'v{major}.{minor}.{patch+1}' } };
    await run();
    expect(createRelease).not.toHaveBeenCalled();
    expect(autoState?.problem).toMatch(/Solo los PRs que se elijan/);
  });
});
