import { describe, it, expect, vi, beforeEach } from 'vitest';

const listOpenManagedIssues = vi.fn();
const listOpenPrsWithChecks = vi.fn();
const listOpenIssues = vi.fn();
const listPrClosingIssues = vi.fn();
const listRecentlyClosed = vi.fn();
vi.mock('../../core/github.js', () => ({
  listRecentlyClosed: () => listRecentlyClosed(),
  listOpenManagedIssues: () => listOpenManagedIssues(),
  listOpenPrsWithChecks: () => listOpenPrsWithChecks(),
  listOpenIssues: () => listOpenIssues(),
  listPrClosingIssues: () => listPrClosingIssues(),
}));
vi.mock('../../core/local-state.js', () => ({ getBlocks: async () => ({}) }));
const listPreviewStates = vi.fn();
vi.mock('../../preview/index.js', () => ({ listPreviewStates: () => listPreviewStates() }));

const { linkPrs, repoGithub, resetGithubCache } = await import('./dashboard-github.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };

beforeEach(() => {
  resetGithubCache();
  listOpenManagedIssues.mockReset().mockResolvedValue([
    { number: 879, title: 'Validar stock', url: 'u', labels: ['ronin', 'ronin:in-progress'], body: '- [x] Slice 1: Reserva — PR: #881\n- [ ] Slice 2: Validar — PR: _pending_' },
  ]);
  listOpenPrsWithChecks.mockReset().mockResolvedValue([]);
  listOpenIssues.mockReset().mockResolvedValue([{ number: 879, title: 'Validar stock', url: 'u', labels: ['ronin'] }, { number: 405, title: 'Otro', url: 'v', labels: [] }]);
  listPrClosingIssues.mockReset().mockResolvedValue({});
  listRecentlyClosed.mockReset().mockResolvedValue({ 870: 'completed', 871: 'not_planned', 880: 'merged' });
  listPreviewStates.mockReset().mockResolvedValue([]);
});

describe('repoGithub', () => {
  it('reads how the latest closed issues and PRs closed, and does without it if that read fails (#129)', async () => {
    expect((await repoGithub(ENTRY))?.closed).toEqual({ 870: 'completed', 871: 'not_planned', 880: 'merged' });
    resetGithubCache();
    listRecentlyClosed.mockRejectedValue(new Error('graphql'));
    const data = await repoGithub(ENTRY);
    expect(data?.closed).toEqual({});
    expect(data?.error).toBeUndefined();
    expect(data?.issues).toHaveLength(1);
  });

  it('reads the issues with their slices', async () => {
    const data = await repoGithub(ENTRY);
    expect(data?.issues).toEqual([{ number: 879, title: 'Validar stock', url: 'u', status: 'in-progress', direct: false, slices: [
      { index: 0, title: 'Reserva', checked: true, prNumber: 881 },
      { index: 1, title: 'Validar', checked: false, prNumber: null },
    ] }]);
  });

  it('reuses a read while it is fresh, and reads again once a run changed after it', async () => {
    const now = Date.now();
    await repoGithub(ENTRY, 0, now);
    await repoGithub(ENTRY, 0, now + 1000);
    expect(listOpenManagedIssues).toHaveBeenCalledTimes(1);

    // A run ended after the read: the next call serves the old read and starts a new one.
    await repoGithub(ENTRY, now + 60_000, now + 2000);
    await vi.waitFor(() => expect(listOpenManagedIssues).toHaveBeenCalledTimes(2));
  });

  it('reads the previews again on every call, while the GitHub read is still fresh', async () => {
    const now = Date.now();
    const preview = { prNumber: 881, appName: 'web', sha: 'abc', url: 'https://h:20001' };
    listPreviewStates.mockResolvedValue([{ ...preview, preparing: true }]);
    expect((await repoGithub(ENTRY, 0, now))?.previews).toEqual([{ prNumber: 881, appName: 'web', url: 'https://h:20001', sha: 'abc', preparing: true }]);
    // Its data got ready: the next poll says so, without asking GitHub again.
    listPreviewStates.mockResolvedValue([preview]);
    expect((await repoGithub(ENTRY, 0, now + 1000))?.previews).toEqual([{ prNumber: 881, appName: 'web', url: 'https://h:20001', sha: 'abc' }]);
    // Moving to a new commit.
    listPreviewStates.mockResolvedValue([{ ...preview, updating: true }]);
    expect((await repoGithub(ENTRY, 0, now + 2000))?.previews?.[0]).toMatchObject({ sha: 'abc', updating: true });
    expect(listOpenManagedIssues).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good read when GitHub fails, with the error', async () => {
    await repoGithub(ENTRY);
    listOpenManagedIssues.mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway\nmore'));
    await repoGithub(ENTRY, Date.now() + 60_000);
    await vi.waitFor(async () => expect((await repoGithub(ENTRY))?.error).toBe('HTTP 502: Bad Gateway'));
    expect((await repoGithub(ENTRY))?.issues).toHaveLength(1);
  });

  it('reads every open issue too, and the issue each PR belongs to', async () => {
    listOpenPrsWithChecks.mockResolvedValue([{ number: 881, headRefName: 'ronin/879/slice-1' }, { number: 910, headRefName: 'feat/actualizar' }]);
    listPrClosingIssues.mockResolvedValue({ 910: [405] });
    const data = await repoGithub(ENTRY);
    expect(data?.openIssues.map((i) => i.number)).toEqual([879, 405]);
    expect(data?.prIssue).toEqual({ 881: 879, 910: 405 });
  });
});

describe('linkPrs', () => {
  const issues = [{ number: 844, slices: [{ index: 0, title: 's', checked: false, prNumber: 849 }] }];
  const open = new Set([844, 405, 228, 788]);

  it("links a ronin slice to its issue, then by what the PR closes, then by its branch's number", () => {
    expect(linkPrs([
      { number: 849, headRefName: 'ronin/844/slice-1' },
      { number: 910, headRefName: 'feat/actualizar-claude-md' },
      { number: 920, headRefName: 'feat/405-algo' },
      { number: 921, headRefName: 'valeria/228/slice-12' },
    ], { 910: [788] }, issues, open)).toEqual({ 849: 844, 910: 788, 920: 405, 921: 228 });
  });

  it('leaves out a PR with no open issue to belong to', () => {
    expect(linkPrs([
      { number: 722, headRefName: 'feat/product-image-tag-scanner' },
      { number: 911, headRefName: 'ronin/exploration/2026-10-16' },
      { number: 930, headRefName: 'fix/999-cerrado' },
    ], { 930: [999] }, issues, open)).toEqual({});
  });
});
