import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDiscussion = vi.fn();
vi.mock('../../core/github.js', () => ({ getDiscussion: (...args: unknown[]) => getDiscussion(...args) }));
vi.mock('../../core/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));

const { itemDetail, resetDetailCache, resolveItem } = await import('./dashboard-detail.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x' };

const pr = (number: number, headRefName: string) => ({ number, title: `PR ${number}`, url: '', author: 'ronin-agent', isDraft: false, headRefName, baseRefName: 'main', reviewDecision: '' as const, checks: [] });
const GH = {
  repo: 'acme/product', fetchedAt: '', previews: [], blocks: {}, openIssues: [], prIssue: {},
  issues: [{ number: 844, title: 'Pedidos', url: '', status: 'in-progress' as const, direct: false, slices: [
    { index: 0, title: 'Columnas', checked: true, prNumber: 801 },
    { index: 1, title: 'Endpoint', checked: false, prNumber: 849 },
    { index: 2, title: 'Pestaña', checked: false, prNumber: null },
  ] }],
  prs: [pr(849, 'ronin/844/slice-2'), pr(860, 'ronin/700/slice-1'), pr(870, 'feature/a-mano')],
};

const discussion = (number: number, comments = 0) => ({
  number, title: `#${number}`, body: 'cuerpo', author: 'Oskr814', createdAt: '', url: '', state: 'OPEN',
  comments: Array.from({ length: comments }, (_, i) => ({ author: 'a', body: `c${i}`, createdAt: '', url: '' })),
});

beforeEach(() => {
  resetDetailCache();
  getDiscussion.mockReset().mockImplementation(async (_kind: string, number: number) => discussion(number, 3));
});

describe('resolveItem', () => {
  it("brings an issue's open slice PR", () => {
    expect(resolveItem(844, GH)).toEqual({ kind: 'issue', number: 844, pr: 849 });
  });

  it("brings a slice PR's tracking issue, from the checklist or else from its branch", () => {
    expect(resolveItem(849, GH)).toEqual({ kind: 'pr', number: 849, issue: 844 });
    expect(resolveItem(860, GH)).toEqual({ kind: 'pr', number: 860, issue: 700 });
    expect(resolveItem(870, GH)).toEqual({ kind: 'pr', number: 870 });
  });

  it("resolves anyone's open issue with its PR, and a PR with the issue it belongs to (#100)", () => {
    const gh = { ...GH, openIssues: [{ number: 405, title: 'Excel', url: '', labels: [] }], prs: [...GH.prs, pr(920, 'feat/405-excel')], prIssue: { 920: 405 } };
    expect(resolveItem(405, gh)).toEqual({ kind: 'issue', number: 405, pr: 920 });
    expect(resolveItem(920, gh)).toEqual({ kind: 'pr', number: 920, issue: 405 });
  });

  it("falls back to what the item's runs say it is, and to nothing without them", () => {
    expect(resolveItem(12, GH, 'pr')).toEqual({ kind: 'pr', number: 12 });
    expect(resolveItem(12, GH)).toBeNull();
    expect(resolveItem(12, undefined, 'issue')).toEqual({ kind: 'issue', number: 12 });
  });
});

describe('itemDetail', () => {
  it('reads both halves, each with its own comments', async () => {
    const detail = await itemDetail(ENTRY, { kind: 'pr', number: 849, issue: 844 });
    expect(getDiscussion).toHaveBeenCalledWith('issue', 844);
    expect(getDiscussion).toHaveBeenCalledWith('pr', 849);
    expect(detail.pr?.comments).toHaveLength(3);
    expect(detail.issue?.comments).toHaveLength(3);
  });

  it("brings the issue's Linear issue, also on a PR's page", async () => {
    const linkback = { author: 'linear-code', body: '<!-- linear-linkback -->\n<p><a href="https://linear.app/red-motos/issue/RED-214/slug">RED-214</a></p>', createdAt: '', url: '' };
    getDiscussion.mockImplementation(async (kind: string, number: number) => ({ ...discussion(number), comments: kind === 'issue' ? [linkback] : [] }));
    const detail = await itemDetail(ENTRY, { kind: 'pr', number: 849, issue: 844 });
    expect(detail.linear).toEqual({ id: 'RED-214', url: 'https://linear.app/red-motos/issue/RED-214/slug' });
  });

  it('has no Linear issue when the issue has no linkback', async () => {
    expect(await itemDetail(ENTRY, { kind: 'issue', number: 844 })).not.toHaveProperty('linear');
  });

  it("keeps a PR's reviews and threads, also on its issue's page", async () => {
    getDiscussion.mockImplementation(async (kind: string, number: number) => ({ ...discussion(number, 1), ...(kind === 'pr' ? { reviews: [{ author: 'a', body: 'ok', state: 'APPROVED', submittedAt: '' }], threads: [{ path: 'a.ts', line: 1, isResolved: false, isOutdated: false, url: '', comments: [] }] } : {}) }));
    const own = await itemDetail(ENTRY, { kind: 'pr', number: 849, issue: 844 });
    expect(own.pr).toMatchObject({ reviews: [{ state: 'APPROVED' }], threads: [{ path: 'a.ts' }] });
    resetDetailCache();
    const other = await itemDetail(ENTRY, { kind: 'issue', number: 844, pr: 849 });
    expect(other.pr).toMatchObject({ reviews: [{ state: 'APPROVED' }], threads: [{ path: 'a.ts' }] });
  });

  it('reuses a read while it is fresh, and reads again once a run changed after it', async () => {
    const now = Date.now();
    await itemDetail(ENTRY, { kind: 'issue', number: 844 }, 0, now);
    await itemDetail(ENTRY, { kind: 'issue', number: 844 }, 0, now + 1000);
    expect(getDiscussion).toHaveBeenCalledTimes(1);

    await itemDetail(ENTRY, { kind: 'issue', number: 844 }, now + 60_000, now + 2000);
    await vi.waitFor(() => expect(getDiscussion).toHaveBeenCalledTimes(2));
  });

  it("keeps the last read with the error when GitHub fails", async () => {
    const now = Date.now();
    await itemDetail(ENTRY, { kind: 'issue', number: 844 }, 0, now);
    getDiscussion.mockRejectedValue(new Error('HTTP 502\nmás detalle'));
    await itemDetail(ENTRY, { kind: 'issue', number: 844 }, now + 60_000, now + 2000);
    await vi.waitFor(async () => {
      const detail = await itemDetail(ENTRY, { kind: 'issue', number: 844 }, 0, now + 3000);
      expect(detail).toMatchObject({ error: 'HTTP 502', issue: { number: 844 } });
    });
  });
});
