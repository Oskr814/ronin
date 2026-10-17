import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentCycle, linearIssuesFor, linearKey } from './linear-api.js';

const ENTRY = { productRepo: 'redmotos/shoppingcart', productRepoPath: '/tmp/x', linear: { apiKeyEnv: 'LINEAR_API_KEY_TEST' } };
const PREFIX = 'https://github.com/redmotos/shoppingcart/issues/';

const raw = (id: string, github: string | null, extra: Record<string, unknown> = {}) => ({
  identifier: id, title: `Issue ${id}`, url: `https://linear.app/red-motos/issue/${id}/slug`,
  state: { name: 'Todo', type: 'unstarted' }, project: null, assignee: null,
  attachments: { nodes: github ? [{ url: github }] : [] },
  ...extra,
});

function respond(data: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY_TEST;
});

describe('linearKey', () => {
  it('reads the key from the env var the repo names, or null', () => {
    expect(linearKey(ENTRY)).toBeNull();
    process.env.LINEAR_API_KEY_TEST = 'lin_api_x';
    expect(linearKey(ENTRY)).toBe('lin_api_x');
    expect(linearKey({ productRepo: 'a/b', productRepoPath: '/x' })).toBeNull();
  });
});

describe('linearIssuesFor', () => {
  it('asks by GitHub URL and maps each Linear issue to its GitHub number', async () => {
    const fetchMock = respond({ data: { issues: { nodes: [
      raw('RED-214', `${PREFIX}909`, { project: { id: 'p1', name: 'Catálogos' }, cycle: { number: 17, name: null, isActive: true }, assignee: { displayName: 'abdias' } }),
      raw('RED-1', null),
    ] } } });
    const found = await linearIssuesFor(ENTRY, 'lin_api_x', [909, 910]);
    expect([...found.keys()]).toEqual([909]);
    expect(found.get(909)).toEqual({
      id: 'RED-214', title: 'Issue RED-214', url: 'https://linear.app/red-motos/issue/RED-214/slug',
      state: { name: 'Todo', type: 'unstarted' }, project: { id: 'p1', name: 'Catálogos' }, assignee: 'abdias',
      githubNumber: 909, cycle: { number: 17, current: true },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('lin_api_x');
    expect(JSON.parse(init.body as string).variables).toEqual({ urls: [`${PREFIX}909`, `${PREFIX}910`], prefix: PREFIX });
  });

  it("fails with Linear's message", async () => {
    respond({ errors: [{ message: 'Authentication required' }] }, 401);
    await expect(linearIssuesFor(ENTRY, 'mala', [1])).rejects.toThrow('Linear respondió 401: Authentication required');
  });
});

describe('currentCycle', () => {
  it("reads the team's active cycle, its history and its issues", async () => {
    respond({ data: { issues: { nodes: [{ team: { key: 'RED', activeCycle: {
      number: 17, name: null, startsAt: '2026-10-12T06:00:00.000Z', endsAt: '2026-10-19T06:00:00.000Z',
      issueCountHistory: [9, 21], completedIssueCountHistory: [7, 19],
      issues: { nodes: [raw('RED-206', `${PREFIX}895`, { state: { name: 'Done', type: 'completed' } })] },
    } } }] } } });
    expect(await currentCycle(ENTRY, 'k')).toEqual({
      team: 'RED', number: 17, startsAt: '2026-10-12T06:00:00.000Z', endsAt: '2026-10-19T06:00:00.000Z',
      scopeHistory: [9, 21], doneHistory: [7, 19],
      issues: [expect.objectContaining({ id: 'RED-206', githubNumber: 895, state: { name: 'Done', type: 'completed' }, cycle: { number: 17, current: true } })],
    });
  });

  it('is null without an active cycle, or without any issue of the repo in Linear', async () => {
    respond({ data: { issues: { nodes: [{ team: { key: 'RED', activeCycle: null } }] } } });
    expect(await currentCycle(ENTRY, 'k')).toBeNull();
    respond({ data: { issues: { nodes: [] } } });
    expect(await currentCycle(ENTRY, 'k')).toBeNull();
  });
});
