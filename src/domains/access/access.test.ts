import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enough, highest, resetAccessCache, sees, sessionAccess, type Permission } from './access.js';
import { GithubUserError } from '../../core/github-as-user.js';

vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const ENTRIES = [{ productRepo: 'redmotos/shoppingcart', productRepoPath: '/a' }, { productRepo: 'Bmedical/bmedical', productRepoPath: '/b' }];
const VALERIA = { login: 'valeria', token: 'gho_v' };

beforeEach(() => resetAccessCache());

describe('highest and enough', () => {
  it("reads GitHub's permissions, and asks for triage at least", () => {
    expect(highest({ pull: true, triage: true, push: true, maintain: false, admin: false })).toBe('push');
    expect(highest({ pull: true })).toBe('pull');
    expect(highest(undefined)).toBeNull();
    expect(enough('pull')).toBe(false);
    expect(enough('triage')).toBe(true);
    expect(enough(null)).toBe(false);
  });
});

describe('sessionAccess', () => {
  it('gives an admin every repo, without asking GitHub', async () => {
    const lookup = vi.fn();
    const access = await sessionAccess({ login: 'oskr814', token: 't' }, ENTRIES, ['oskr814'], Date.now(), lookup);
    expect(access.admin).toBe(true);
    expect(access.repos.map((r) => r.repo)).toEqual(['redmotos/shoppingcart', 'Bmedical/bmedical']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('gives anyone else the repos they can triage, with their own token', async () => {
    const lookup = vi.fn(async (_t: string, repo: string): Promise<Permission | null> => (repo === 'redmotos/shoppingcart' ? 'triage' : 'pull'));
    const access = await sessionAccess(VALERIA, ENTRIES, ['oskr814'], Date.now(), lookup);
    expect(access).toEqual({ admin: false, repos: [{ repo: 'redmotos/shoppingcart', permission: 'triage' }] });
    expect(lookup).toHaveBeenCalledWith('gho_v', 'Bmedical/bmedical');
    expect(sees(access, 'redmotos/shoppingcart')).toBe(true);
    expect(sees(access, 'Bmedical/bmedical')).toBe(false);
  });

  it('asks again once the cache is old, and serves the last answer meanwhile', async () => {
    let answer: Permission | null = 'push';
    const lookup = vi.fn(async () => answer);
    const now = Date.now();
    await sessionAccess(VALERIA, ENTRIES, [], now, lookup);
    await sessionAccess(VALERIA, ENTRIES, [], now + 60_000, lookup);
    expect(lookup).toHaveBeenCalledTimes(2); // one per repo, once

    answer = null; // taken off on GitHub
    const stale = await sessionAccess(VALERIA, ENTRIES, [], now + 11 * 60_000, lookup);
    expect(stale.repos).toHaveLength(2);
    await vi.waitFor(async () => expect((await sessionAccess(VALERIA, ENTRIES, [], now + 11 * 60_000, lookup)).repos).toEqual([]));
  });

  it('fails closed when GitHub fails the first time, and keeps the last answer after', async () => {
    const failing = vi.fn(async () => {
      throw new Error('GitHub respondió 502');
    });
    expect((await sessionAccess(VALERIA, ENTRIES, [], Date.now(), failing)).repos).toEqual([]);
  });

  it('passes up a revoked token, to end the session', async () => {
    const revoked = vi.fn(async () => {
      throw new GithubUserError('venció', true);
    });
    await expect(sessionAccess(VALERIA, ENTRIES, [], Date.now(), revoked)).rejects.toThrow(GithubUserError);
  });
});
