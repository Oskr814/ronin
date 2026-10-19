import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RepoData } from './collect.js';

const syncRepo = vi.fn();
vi.mock('./collect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./collect.js')>()),
  readRepoData: async () => null,
  syncRepo: (repo: string) => syncRepo(repo),
}));

const { metricsView, parsePeriod, resetMetricsCache } = await import('./index.js');

const data = (repo: string, syncedAt: string): RepoData => ({ repo, syncedAt, issues: {}, prs: {}, releases: [] });

beforeEach(() => {
  vi.clearAllMocks();
  resetMetricsCache();
});

describe('metricsView', () => {
  it('waits for the first read, then reads GitHub again only after 10 minutes', async () => {
    syncRepo.mockImplementation(async (repo: string) => data(repo, '2026-10-19T12:00:00.000Z'));
    const first = await metricsView(['acme/tienda'], 30, null, Date.now());
    expect(first.sources).toEqual([{ repo: 'acme/tienda', syncedAt: '2026-10-19T12:00:00.000Z' }]);
    await metricsView(['acme/tienda'], 7, null, Date.now() + 60_000);
    expect(syncRepo).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous read, with the error, when GitHub fails', async () => {
    syncRepo.mockResolvedValueOnce(data('acme/tienda', 'antes'));
    await metricsView(['acme/tienda'], 30, null, Date.now());
    syncRepo.mockRejectedValueOnce(new Error('HTTP 502\ndetalle'));
    await metricsView(['acme/tienda'], 30, null, Date.now() + 11 * 60_000);
    await new Promise((r) => setTimeout(r, 0));
    const view = await metricsView(['acme/tienda'], 30, null, Date.now() + 11 * 60_000);
    expect(view.sources).toEqual([{ repo: 'acme/tienda', syncedAt: 'antes', error: 'HTTP 502' }]);
  });

  it('reads only the repo asked for', async () => {
    syncRepo.mockImplementation(async (repo: string) => data(repo, 'x'));
    const view = await metricsView(['acme/tienda', 'acme/panel'], 30, 'acme/panel', Date.now());
    expect(syncRepo).toHaveBeenCalledWith('acme/panel');
    expect(view.sources.map((s) => s.repo)).toEqual(['acme/panel']);
    expect(view.repos).toEqual(['acme/tienda', 'acme/panel']);
  });
});

describe('parsePeriod', () => {
  it('takes 7, 30 or 90 days, 30 by default', () => {
    expect(parsePeriod(null)).toBe(30);
    expect(parsePeriod('90')).toBe(90);
    expect(parsePeriod('14')).toBeNull();
  });
});
