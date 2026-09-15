import { describe, it, expect, vi, beforeEach } from 'vitest';

const listReleases = vi.fn();
vi.mock('./github.js', () => ({
  listReleases: (...args: unknown[]) => listReleases(...args),
}));

const getLastChangelogRelease = vi.fn();
const setLastChangelogRelease = vi.fn();
vi.mock('./local-state.js', () => ({
  getLastChangelogRelease: (...args: unknown[]) => getLastChangelogRelease(...args),
  setLastChangelogRelease: (...args: unknown[]) => setLastChangelogRelease(...args),
}));

const activeRepo = vi.fn();
vi.mock('./repo-context.js', () => ({
  activeRepo: (...args: unknown[]) => activeRepo(...args),
}));

import { findReleasesNeedingChangelog } from './changelog.js';

function release(overrides: Partial<{ tagName: string; name: string; url: string; publishedAt: string; isDraft: boolean; isPrerelease: boolean }> = {}) {
  return {
    tagName: 'v1.0.0',
    name: 'v1.0.0',
    url: 'https://github.com/redmotos/shoppingcart/releases/tag/v1.0.0',
    publishedAt: '2026-01-01T00:00:00Z',
    isDraft: false,
    isPrerelease: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activeRepo.mockReturnValue({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/tmp/repo', changelogRepo: 'redmotos/changelog', changelogRepoPath: '/tmp/changelog' });
});

describe('findReleasesNeedingChangelog', () => {
  it('is a no-op for a repo with no changelogRepo configured', async () => {
    activeRepo.mockReturnValue({ productRepo: 'redmotos/other', productRepoPath: '/tmp/repo' });

    const result = await findReleasesNeedingChangelog();

    expect(result).toEqual([]);
    expect(listReleases).not.toHaveBeenCalled();
  });

  it('seeds the baseline at the current latest release on the first run, generating no candidates', async () => {
    getLastChangelogRelease.mockResolvedValue(undefined);
    listReleases.mockResolvedValue([
      release({ tagName: 'v1', publishedAt: '2026-01-01T00:00:00Z' }),
      release({ tagName: 'v2', publishedAt: '2026-02-01T00:00:00Z' }),
    ]);

    const result = await findReleasesNeedingChangelog();

    expect(result).toEqual([]);
    expect(setLastChangelogRelease).toHaveBeenCalledWith('v2', '2026-02-01T00:00:00Z');
  });

  it('does not seed anything when there are no releases at all yet', async () => {
    getLastChangelogRelease.mockResolvedValue(undefined);
    listReleases.mockResolvedValue([]);

    const result = await findReleasesNeedingChangelog();

    expect(result).toEqual([]);
    expect(setLastChangelogRelease).not.toHaveBeenCalled();
  });

  it('returns releases published after the last processed one, oldest first', async () => {
    getLastChangelogRelease.mockResolvedValue({ tag: 'v1', publishedAt: '2026-01-01T00:00:00Z' });
    listReleases.mockResolvedValue([
      release({ tagName: 'v3', publishedAt: '2026-03-01T00:00:00Z' }),
      release({ tagName: 'v2', publishedAt: '2026-02-01T00:00:00Z' }),
    ]);

    const result = await findReleasesNeedingChangelog();

    expect(result.map((c) => c.release.tagName)).toEqual(['v2', 'v3']);
    expect(setLastChangelogRelease).not.toHaveBeenCalled();
  });

  it('excludes drafts and prereleases', async () => {
    getLastChangelogRelease.mockResolvedValue({ tag: 'v0', publishedAt: '2025-01-01T00:00:00Z' });
    listReleases.mockResolvedValue([
      release({ tagName: 'v1-draft', publishedAt: '2026-01-01T00:00:00Z', isDraft: true }),
      release({ tagName: 'v1-pre', publishedAt: '2026-01-02T00:00:00Z', isPrerelease: true }),
      release({ tagName: 'v1', publishedAt: '2026-01-03T00:00:00Z' }),
    ]);

    const result = await findReleasesNeedingChangelog();

    expect(result.map((c) => c.release.tagName)).toEqual(['v1']);
  });

  it('returns nothing when the latest processed release is already the newest', async () => {
    getLastChangelogRelease.mockResolvedValue({ tag: 'v2', publishedAt: '2026-02-01T00:00:00Z' });
    listReleases.mockResolvedValue([release({ tagName: 'v2', publishedAt: '2026-02-01T00:00:00Z' })]);

    const result = await findReleasesNeedingChangelog();

    expect(result).toEqual([]);
  });
});
