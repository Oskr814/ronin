import { describe, it, expect } from 'vitest';
import { readRepoData, syncRepo, toIssue, toPr, type RawIssue, type RawPr } from './collect.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const rawIssue = (number: number, updatedDaysAgo: number, over: Partial<RawIssue> = {}): RawIssue => ({
  number, title: `issue ${number}`, createdAt: ago(300 * DAY), updatedAt: ago(updatedDaysAgo * DAY), closedAt: null, stateReason: null,
  author: { login: 'ana-dev' }, assignees: { nodes: [] }, labels: { nodes: [] }, timelineItems: { nodes: [] }, ...over,
});
const rawPr = (number: number, updatedDaysAgo: number): RawPr => ({
  number, title: `PR ${number}`, createdAt: ago(10 * DAY), updatedAt: ago(updatedDaysAgo * DAY), mergedAt: null, closedAt: null, isDraft: false,
  author: { login: 'ana-dev' }, closingIssuesReferences: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] },
});

describe('toIssue and toPr', () => {
  it('keep how an issue closed, when it was reopened and when it got ronin:blocked', () => {
    const issue = toIssue(rawIssue(1, 1, {
      closedAt: ago(DAY), stateReason: 'DUPLICATE', assignees: { nodes: [{ login: 'ronin-agent' }] },
      timelineItems: { nodes: [
        { __typename: 'ReopenedEvent', createdAt: ago(5 * DAY) },
        { __typename: 'LabeledEvent', createdAt: ago(4 * DAY), label: { name: 'ronin:blocked' } },
        { __typename: 'LabeledEvent', createdAt: ago(4 * DAY), label: { name: 'bug' } },
      ] },
    }));
    expect(issue).toMatchObject({ reason: 'not_planned', assignees: ['ronin-agent'], reopenedAt: [ago(5 * DAY)], blockedAt: [ago(4 * DAY)] });
    expect(toIssue(rawIssue(2, 1, { closedAt: ago(DAY), stateReason: null })).reason).toBe('completed');
    expect(toIssue(rawIssue(3, 1)).reason).toBeNull();
  });

  it("keep a PR's people review requests, its submitted reviews and its fix attempts", () => {
    const raw = rawPr(9, 1);
    raw.reviews.nodes = [{ author: { login: 'beto-dev' }, state: 'APPROVED', submittedAt: ago(DAY) }, { author: { login: 'caro-dev' }, state: 'PENDING', submittedAt: null }];
    raw.timelineItems.nodes = [
      { __typename: 'ReviewRequestedEvent', createdAt: ago(3 * DAY), requestedReviewer: { login: 'beto-dev' } },
      { __typename: 'ReviewRequestedEvent', createdAt: ago(3 * DAY), requestedReviewer: {} },
      { __typename: 'ReadyForReviewEvent', createdAt: ago(4 * DAY) },
      { __typename: 'LabeledEvent', createdAt: ago(2 * DAY), label: { name: 'ronin:attempts-1' } },
      { __typename: 'LabeledEvent', createdAt: ago(DAY), label: { name: 'ronin:attempts-2' } },
    ];
    expect(toPr(raw)).toMatchObject({
      readyAt: ago(4 * DAY),
      requests: [{ reviewer: 'beto-dev', at: ago(3 * DAY) }],
      reviews: [{ author: 'beto-dev', state: 'APPROVED', at: ago(DAY) }],
      attempts: 2,
    });
  });
});

// A fake GitHub: pages of 2, newest-updated first, as the queries order them.
function fakeGithub(issues: RawIssue[], prs: RawPr[]) {
  const calls: string[] = [];
  const graphql = async <T>(query: string, vars: Record<string, string | number | undefined>): Promise<T> => {
    const field = query.includes('releases(') ? 'releases' : query.includes('pullRequests(') ? 'pullRequests' : 'issues';
    const openOnly = /states: \[OPEN\]/.test(query);
    calls.push(`${field}${openOnly ? ':open' : ''}@${vars.after ?? 0}`);
    if (field === 'releases') return { data: { repository: { releases: { nodes: [{ tagName: 'v1', createdAt: ago(DAY), publishedAt: ago(DAY), isPrerelease: false, isDraft: false }, { tagName: 'v2', createdAt: ago(DAY), publishedAt: null, isPrerelease: false, isDraft: true }], pageInfo: { hasNextPage: false, endCursor: null } } } } } as T;
    const all = (field === 'issues' ? issues : prs).filter((n) => !openOnly || !n.closedAt).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    const from = Number(vars.after ?? 0);
    return { data: { repository: { [field]: { nodes: all.slice(from, from + 2), pageInfo: { hasNextPage: from + 2 < all.length, endCursor: String(from + 2) } } } } } as T;
  };
  return { graphql: graphql as never, calls };
}

describe('syncRepo', () => {
  it('first brings 6 months back, and every open issue however old', async () => {
    const issues = [rawIssue(1, 1), rawIssue(2, 10), rawIssue(3, 200, { closedAt: ago(200 * DAY) }), rawIssue(4, 400)];
    const { graphql } = fakeGithub(issues, [rawPr(5, 2)]);
    const data = await syncRepo('acme/primera', NOW, graphql);
    expect(Object.keys(data.issues).sort()).toEqual(['1', '2', '4']);
    expect(Object.keys(data.prs)).toEqual(['5']);
    expect(data.releases).toEqual([{ tag: 'v1', publishedAt: ago(DAY), prerelease: false }]);
    expect((await readRepoData('acme/primera'))?.syncedAt).toBe(new Date(NOW).toISOString());
  });

  it('then asks only for what changed since the last read', async () => {
    const issues = [rawIssue(1, 30), rawIssue(2, 40), rawIssue(3, 50)];
    await syncRepo('acme/segunda', NOW - 20 * DAY, fakeGithub(issues, []).graphql);

    issues[2] = rawIssue(3, 1, { closedAt: ago(DAY), stateReason: 'COMPLETED' });
    const later = fakeGithub(issues, []);
    const data = await syncRepo('acme/segunda', NOW, later.graphql);
    expect(data.issues[3].reason).toBe('completed');
    expect(Object.keys(data.issues).sort()).toEqual(['1', '2', '3']);
    // The first page already reached what's older than the last read: no second one, and no open-only reads.
    expect(later.calls.filter((c) => c.startsWith('issues'))).toEqual(['issues@0']);
  });
});
