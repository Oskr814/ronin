import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Two repos; the session below sees only shoppingcart (#106). Every
// endpoint must keep bmedical out: in lists, it isn't there; asked by
// name, it doesn't exist.
const SC = 'redmotos/shoppingcart';
const BM = 'Bmedical/bmedical';
vi.mock('../../core/repos.js', () => ({
  loadRepos: async () => [
    { productRepo: SC, productRepoPath: '/tmp/sc', claudeConfigDir: '/home/x/.claude-redmotos' },
    { productRepo: BM, productRepoPath: '/tmp/bm', claudeConfigDir: '/home/x/.claude-bmedical' },
  ],
}));
vi.mock('./dashboard-github.js', () => ({
  repoGithub: async (entry: { productRepo: string }) => ({ repo: entry.productRepo, fetchedAt: '', issues: [], openIssues: [{ number: 1, title: `issue de ${entry.productRepo}`, url: '', labels: [] }], prs: [{ number: 2, title: 'PR', url: '', author: 'a', isDraft: false, headRefName: 'feat/x', baseRefName: 'main', reviewDecision: '', checks: [] }], prIssue: {}, previews: [], blocks: {} }),
  forgetGithub: vi.fn(),
}));
vi.mock('./dashboard-linear.js', () => ({ repoLinear: async () => undefined, cycleView: () => null }));
vi.mock('./dashboard-new-issue.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./dashboard-new-issue.js')>()), repoApps: async () => [] }));
vi.mock('./dashboard-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dashboard-files.js')>()),
  prFiles: async () => ({ fetchedAt: '', headSha: 'h', baseSha: 'b', files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }], threads: [] }),
  fileContent: async () => 'a\n',
}));
vi.mock('./dashboard-detail.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./dashboard-detail.js')>()), itemDetail: async () => ({ fetchedAt: '' }) }));

const dir = mkdtempSync(join(tmpdir(), 'ronin-access-'));
const run = (runId: string, repo: string) => ({ runId, repo, taskType: 'implement-slice', label: 'x', account: 'a', worktree: '/w', startedAt: new Date().toISOString(), state: 'ok' as const, steps: 1, issueNumber: 1 });
vi.mock('./dashboard-data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dashboard-data.js')>()),
  listRuns: () => [run('r-sc', SC), run('r-bm', BM)],
  readQueue: () => [{ kind: 'issue', label: '#1', repo: SC, since: '' }, { kind: 'issue', label: '#2', repo: BM, since: '' }],
  readUsage: () => [{ account: 'redmotos' }, { account: 'bmedical' }],
  readTickInfo: () => ({}),
  slotsInUse: () => 0,
  runPath: (runId: string) => join(dir, `${runId}.jsonl`),
}));

const { handleDashboard } = await import('./dashboard.js');
const ACCESS = { admin: false, repos: [{ repo: SC, permission: 'triage' as const }] };
const SESSION = { login: 'valeria', token: 'gho_v' };

async function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const req = { method, url: path, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
  const out = { status: 0, body: undefined as any };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(text?: string) { out.body = text ? JSON.parse(text) : undefined; return res; },
  } as unknown as ServerResponse;
  await handleDashboard(req, res, path.split('?')[0], SESSION, ACCESS);
  return out;
}

beforeAll(() => {
  for (const [id, repo] of [['r-sc', SC], ['r-bm', BM]]) writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'run_start', ...run(id, repo) }) + '\n');
});

describe('a session that sees only some repos', () => {
  it('gets a snapshot of only those: items, runs, queue and Claude accounts', async () => {
    const { status, body } = await call('/api/snapshot');
    expect(status).toBe(200);
    expect(body.repos).toEqual([SC]);
    expect(new Set(body.items.map((i: { repo: string }) => i.repo))).toEqual(new Set([SC]));
    expect(body.runner.queue.map((j: { repo: string }) => j.repo)).toEqual([SC]);
    expect(body.usage.map((u: { account: string }) => u.account)).toEqual(['redmotos']);
    expect(body.access).toEqual(ACCESS);
  });

  it("gets today's runs of only those", async () => {
    const { body } = await call('/api/today');
    expect(body.timeline.map((r: { repo: string }) => r.repo)).toEqual([SC]);
  });

  it("doesn't find anything of another repo by name", async () => {
    expect((await call(`/api/items/${encodeURIComponent(`${BM}#1`)}/detail`)).status).toBe(404);
    expect((await call(`/api/items/${encodeURIComponent(`${BM}#1`)}`)).status).toBe(404);
    expect((await call('/api/runs/r-bm')).status).toBe(404);
    expect((await call(`/api/evidence/${BM}/abc/a.png`)).status).toBe(404);
    expect((await call(`/api/repos/${BM}/issues`, 'POST', { title: 'x' })).status).toBe(404);
    expect((await call(`/api/items/${encodeURIComponent(`${BM}#1`)}/actions`, 'POST', { action: 'resolve-conflicts' })).status).toBe(404);
    expect((await call(`/api/items/${encodeURIComponent(`${BM}#2`)}/files`)).status).toBe(404);
    expect((await call(`/api/items/${encodeURIComponent(`${BM}#2`)}/files/content?path=a.ts`)).status).toBe(404);
  });

  it('still finds what is of its repos', async () => {
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#1`)}/detail`)).status).toBe(200);
    expect((await call('/api/runs/r-sc')).status).toBe(200);
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#2`)}/files`)).body).toMatchObject({ pr: 2, files: [{ path: 'a.ts' }] });
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#2`)}/files/content?path=a.ts`)).body).toEqual({ sha: 'h', text: 'a\n' });
  });

  it("reads only a file the PR changes (#111)", async () => {
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#2`)}/files/content?path=.env`)).status).toBe(404);
  });
});
