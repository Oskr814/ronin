import { beforeEach, describe, expect, it, vi } from 'vitest';

const listReleases = vi.fn();

const pendingChanges = vi.fn();
const followDeploys = vi.fn();
const listDeploys = vi.fn();
const planRelease = vi.fn();
const publishRelease = vi.fn();
vi.mock('./index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./index.js')>()),
  pendingChanges: (...args: unknown[]) => pendingChanges(...args),
  readRepo: async () => ({ releases: await listReleases(), merged: [], requests: [] }),
  followDeploys: (...args: unknown[]) => followDeploys(...args),
  listDeploys: (...args: unknown[]) => listDeploys(...args),
  planRelease: (...args: unknown[]) => planRelease(...args),
  publishRelease: (...args: unknown[]) => publishRelease(...args),
}));

import { DeployError, type DeployRecord, type Plan } from './index.js';
import { DeployBoardError, deploysView, parseRelease, planBoardRelease, publishBoardRelease, resetDeployReads } from './board.js';

const entry = { productRepo: 'acme/app', productRepoPath: '/tmp/app', deploy: { prerelease: true, selective: true } };
const change = { sha: 'c1', subject: 'fix: algo (#3)', pr: 3, files: ['apps/web/a.ts'], apps: ['web'], pedidos: [7] };
const pending = (prerelease = false) => ({ branch: 'main', head: 'h1', base: { tag: prerelease ? 'rc1' : 'v1.0.0', sha: 'b' }, changes: [change] });
const release = (tagName: string, publishedAt: string, isPrerelease = false) => ({ tagName, name: tagName, url: `https://github.com/acme/app/releases/tag/${tagName}`, publishedAt, isDraft: false, isPrerelease });
const record = (over: Partial<DeployRecord>): DeployRecord => ({ repo: 'acme/app', tag: 'v1.0.0', prerelease: false, mode: 'pick', base: 'v0.9.0', sha: 's', url: '', changes: [{ pr: 3, subject: 'x' }], pedidos: [7], by: 'persona', at: '2026-10-18T10:00:00Z', state: 'deployed', ...over });
const plan = (over: Partial<Plan> = {}): Plan => ({ repo: 'acme/app', tag: 'v1.0.1', prerelease: false, mode: 'pick', branch: 'main', base: { tag: 'v1.0.0', sha: 'b' }, target: 't', changes: [change], apps: ['web'], notes: '## Qué entra', problems: [], fingerprint: 'f', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  resetDeployReads();
  pendingChanges.mockImplementation(async (opts?: { prerelease?: boolean }) => pending(Boolean(opts?.prerelease)));
  listReleases.mockResolvedValue([release('v0.9.0', '2026-10-17T00:00:00Z'), release('rc1', '2026-10-18T09:00:00Z', true), release('v1.0.0', '2026-10-18T10:00:00Z'), { ...release('borrador', '2026-10-18T11:00:00Z'), isDraft: true }]);
  listDeploys.mockResolvedValue([record({}), record({ tag: 'v1.0.2', releaseError: 'HTTP 502', state: 'running' })]);
});

describe('deploysView', () => {
  it('shows each repo with deploy: what is pending (and for a pre-release), and its releases with what ronin knows of them', async () => {
    const [repo] = await deploysView([entry, { productRepo: 'otro/repo', productRepoPath: '/tmp/o' }]) as any[];
    expect(repo).toMatchObject({ repo: 'acme/app', branch: 'main', prerelease: true, selective: true, pending: { base: 'v1.0.0', changes: [{ pr: 3, apps: ['web'], pedidos: [7] }] }, prePending: { base: 'rc1' } });
    expect(repo.releases.map((r: any) => [r.tag, r.latest, r.prerelease, r.deploy?.state])).toEqual([
      ['v1.0.2', false, false, 'running'], ['v1.0.0', true, false, 'deployed'], ['rc1', false, true, undefined], ['v0.9.0', false, false, undefined],
    ]);
    expect(repo.releases[0].deploy.releaseError).toBe('HTTP 502');
    expect(pendingChanges).toHaveBeenCalledTimes(2);
  });

  it('follows a deploy still going before answering', async () => {
    await deploysView([entry]);
    expect(followDeploys).toHaveBeenCalled();
    listDeploys.mockResolvedValue([record({})]);
    followDeploys.mockClear();
    await deploysView([entry]);
    expect(followDeploys).not.toHaveBeenCalled();
  });

  it('reads GitHub once while the page keeps asking, and again after a publish', async () => {
    await deploysView([entry]);
    await deploysView([entry]);
    expect(listReleases).toHaveBeenCalledTimes(1);
    publishRelease.mockResolvedValue({ ...record({ tag: 'v1.0.1' }), url: 'u' });
    await publishBoardRelease(entry, { tag: 'v1.0.1', prs: [3] }, 'persona');
    await deploysView([entry]);
    expect(listReleases).toHaveBeenCalledTimes(2);
  });

  it('serves the last read while a newer one is on its way', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-20T10:00:00Z'), toFake: ['Date'] });
    try {
      await deploysView([entry]);
      vi.setSystemTime(Date.parse('2026-10-20T10:05:00Z'));
      listReleases.mockReturnValue(new Promise(() => {}));
      const [repo] = await deploysView([entry]) as any[];
      expect(repo.releases.map((r: any) => r.tag)).toContain('v1.0.0');
      expect(listReleases).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a repo could not be read, and still shows the others', async () => {
    pendingChanges.mockRejectedValueOnce(new Error('fatal: could not read from remote\nmás'));
    expect(await deploysView([entry])).toEqual([{ repo: 'acme/app', error: 'fatal: could not read from remote' }]);
  });
});

describe('parseRelease', () => {
  it('takes a tag, all or some PRs, and the optional fields', () => {
    expect(parseRelease({ tag: ' v1 ', prs: 'all' })).toEqual({ tag: 'v1', prs: 'all' });
    expect(parseRelease({ tag: 'v1', prs: [3, 4], prerelease: true, title: 'T', notes: 'N', fingerprint: 'f' })).toEqual({ tag: 'v1', prs: [3, 4], prerelease: true, title: 'T', notes: 'N', fingerprint: 'f' });
  });

  it('refuses what is not', () => {
    for (const bad of [{ prs: 'all' }, { tag: 'v1' }, { tag: 'v1', prs: ['3'] }, { tag: 'v1', prs: [0] }, { tag: 'v1', prs: 'all', prerelease: 'sí' }, { tag: 'v1', prs: 'all', notes: 3 }]) {
      expect(() => parseRelease(bad)).toThrow(DeployBoardError);
    }
  });
});

describe('plan and publish', () => {
  it('plans with the problems in words', async () => {
    planRelease.mockResolvedValue(plan({ target: null, problems: [{ kind: 'tag-exists' }] }));
    expect(await planBoardRelease(entry, { tag: 'v1.0.1', prs: [3] })).toMatchObject({ tag: 'v1.0.1', changes: [{ pr: 3 }], messages: ['Ese tag ya existe: escribe uno nuevo.'], fingerprint: 'f' });
  });

  it('publishes as whoever is logged in, and answers a refusal with 409 and the plan', async () => {
    publishRelease.mockResolvedValue(record({ tag: 'v1.0.1', url: 'u', pedidos: [7] }));
    expect(await publishBoardRelease(entry, { tag: 'v1.0.1', prs: [3] }, 'persona')).toEqual({ tag: 'v1.0.1', url: 'u', pedidos: [7] });
    expect(publishRelease).toHaveBeenCalledWith({ tag: 'v1.0.1', prs: [3], by: 'persona' });

    publishRelease.mockRejectedValue(new DeployError('Lo que entra cambió desde que lo viste', plan()));
    const refused = await publishBoardRelease(entry, { tag: 'v1.0.1', prs: [3] }, 'persona').catch((e) => e);
    expect(refused).toBeInstanceOf(DeployBoardError);
    expect(refused).toMatchObject({ status: 409, details: { plan: { tag: 'v1.0.1', fingerprint: 'f' } } });
  });
});
