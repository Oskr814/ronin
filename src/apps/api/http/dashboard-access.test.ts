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
vi.mock('../../../platform/config/repos.js', () => ({
  loadRepos: async () => [
    { productRepo: SC, productRepoPath: '/tmp/sc', claudeConfigDir: '/home/x/.claude-redmotos' },
    { productRepo: BM, productRepoPath: '/tmp/bm', claudeConfigDir: '/home/x/.claude-bmedical' },
  ],
}));
vi.mock('../../../domains/items/github.js', () => ({
  repoGithub: async (entry: { productRepo: string }) => ({ repo: entry.productRepo, fetchedAt: '', issues: [], openIssues: [{ number: 1, title: `issue de ${entry.productRepo}`, url: '', labels: [] }], prs: [{ number: 2, title: 'PR', url: '', author: 'a', isDraft: false, headRefName: 'feat/x', baseRefName: 'main', reviewDecision: '', checks: [] }], prIssue: {}, previews: [], blocks: {} }),
  forgetGithub: vi.fn(),
}));
vi.mock('../../../domains/items/linear.js', () => ({ repoLinear: async () => undefined, cycleView: () => null }));
vi.mock('../../../domains/items/new-issue.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../domains/items/new-issue.js')>()), repoApps: async () => [] }));
vi.mock('../../../domains/items/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../domains/items/files.js')>()),
  prFiles: async () => ({ fetchedAt: '', prId: 'PR_2', author: 'a', headSha: 'h', baseSha: 'b', files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }], threads: [] }),
  fileContent: async () => 'a\n',
}));
vi.mock('../../../domains/items/detail.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../domains/items/detail.js')>()), itemDetail: async () => ({ fetchedAt: '' }) }));

const dir = mkdtempSync(join(tmpdir(), 'ronin-access-'));
const run = (runId: string, repo: string) => ({ runId, repo, taskType: 'implement-slice', label: 'x', account: 'a', worktree: '/w', startedAt: new Date().toISOString(), state: 'ok' as const, steps: 1, issueNumber: 1 });
vi.mock('../../../domains/runs/data.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../domains/runs/data.js')>()),
  listRuns: () => [run('r-sc', SC), run('r-bm', BM)],
  readQueue: () => [{ kind: 'issue', label: '#1', repo: SC, since: '' }, { kind: 'issue', label: '#2', repo: BM, since: '' }],
  readTickInfo: () => ({}),
  slotsInUse: () => ({}),
  runPath: (runId: string) => join(dir, `${runId}.jsonl`),
}));

vi.mock('../../../platform/claude/claude-usage.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../platform/claude/claude-usage.js')>()), listUsage: async () => [{ account: 'redmotos' }, { account: 'bmedical' }] }));

const launchMeetingWorker = vi.fn(async (_n: number) => {});
vi.mock('../../../domains/meetings/launch.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../domains/meetings/launch.js')>()), launchMeetingWorker: (n: number) => launchMeetingWorker(n) }));

const metricsView = vi.fn(async (repos: string[], days: number, repo: string | null) => ({ repos, days, repo }));
vi.mock('../../../domains/metrics/index.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../domains/metrics/index.js')>()), metricsView: (...args: [string[], number, string | null]) => metricsView(...args) }));

const { handleDashboard } = await import('./dashboard.js');
const ACCESS = { admin: false, repos: [{ repo: SC, permission: 'triage' as const }] };
const SESSION = { login: 'valeria', token: 'gho_v' };

async function call(path: string, method = 'GET', body?: unknown, access: typeof ACCESS = ACCESS): Promise<{ status: number; body: any }> {
  const req = { method, url: path, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
  const out = { status: 0, body: undefined as any };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(text?: string) { out.body = text ? JSON.parse(text) : undefined; return res; },
  } as unknown as ServerResponse;
  await handleDashboard(req, res, path.split('?')[0], SESSION, access);
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

  it('can neither see nor publish deploys without being an admin (#158)', async () => {
    expect((await call('/api/snapshot')).body.despliegues).toBe(false);
    expect((await call('/api/deploys')).status).toBe(403);
    expect((await call(`/api/deploys/${SC}/plan`, 'POST', { tag: 'v1', prs: 'all' })).status).toBe(403);
    expect((await call(`/api/deploys/${SC}/publish`, 'POST', { tag: 'v1', prs: 'all' })).status).toBe(403);
  });

  it('cannot see the metrics without being an admin (#222)', async () => {
    expect((await call('/api/metricas')).status).toBe(403);
    expect(metricsView).not.toHaveBeenCalled();
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

  it("sees the portal's requests of its repos only (#132)", async () => {
    const { createRequest } = await import('../../../domains/portal/requests.js');
    const sc = await createRequest({ userId: 'u', repo: SC, app: 'web', text: 'Hola', images: [{ ext: 'png', data: Buffer.from('x') }] });
    const bm = await createRequest({ userId: 'u', repo: BM, app: 'web', text: 'Hola', images: [] });
    expect((await call('/api/pedidos')).body.requests.map((r: { number: number }) => r.number)).toEqual([sc.number]);
    expect((await call('/api/snapshot')).body).toMatchObject({ pedidosTotal: 1, pedidos: [{ number: sc.number, waitsOn: 'ronin' }] });
    expect((await call(`/api/pedidos/${sc.number}`)).body).toMatchObject({ number: sc.number, person: 'Cuenta borrada', messages: [{ text: 'Hola' }] });
    expect((await call(`/api/pedidos/${bm.number}`)).status).toBe(404);
    // Only an image the request has, by its name.
    expect((await call(`/api/pedidos/${sc.number}/img/..%2F..%2Frequest.json`)).status).toBe(404);
    expect((await call(`/api/pedidos/${sc.number}/prototipo/1`)).status).toBe(404);
    expect((await call(`/api/pedidos/${sc.number}/reproduccion/1`)).status).toBe(404);
    // A reported error's reproduction: in its page, and its diff by round (#137).
    const { prototypePatchPath, updateRequest: update } = await import('../../../domains/portal/requests.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(prototypePatchPath(sc.number, 'r1.diff')), { recursive: true });
    await writeFile(prototypePatchPath(sc.number, 'r1.diff'), '+[Fact]\n');
    await update(sc.number, (r) => { r.bug = { steps: 's', reproductions: [{ round: 1, reproduced: true, steps: [], summary: '', patch: 'r1.diff', messageId: 1, at: '' }] }; });
    expect((await call(`/api/pedidos/${sc.number}/reproduccion/1`)).body).toEqual({ patch: '+[Fact]\n' });
    expect((await call(`/api/pedidos/${sc.number}/prototipo/1`)).status).toBe(404);
    expect((await call(`/api/pedidos/${sc.number}`)).body).toMatchObject({ bug: { steps: 's', reproductions: [{ round: 1 }] } });
    expect((await call('/api/pedidos')).body.requests[0]).toMatchObject({ bug: true });
    // The issue it became says so on its page.
    const { updateRequest } = await import('../../../domains/portal/requests.js');
    await updateRequest(sc.number, (r) => { r.issue = { number: 1, url: '' }; });
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#1`)}/detail`)).body.pedido).toEqual({ number: sc.number, title: 'Hola' });
  });

  it('sees and uploads the meetings of its repos only (#62)', async () => {
    const notes = 'Exportar pedidos: bodega pidió bajar a Excel la lista de pedidos con los filtros puestos.';
    const up = await call('/api/meetings', 'POST', { repo: SC, text: notes, title: 'Llamada con bodega', at: '2026-10-16T15:00:00.000Z' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ repo: SC, title: 'Llamada con bodega', by: 'valeria', status: 'pending', source: { kind: 'pasted' } });
    // Not to a repo it doesn't see.
    expect((await call('/api/meetings', 'POST', { repo: BM, text: notes })).body).toEqual({ error: 'Elige un repo de los que ves.' });
    // The same notes again: which meeting has them.
    expect(await call('/api/meetings', 'POST', { repo: SC, text: `  ${notes}\n` })).toEqual({ status: 409, body: { error: `Esas notas ya se subieron: R-${up.body.number}.`, number: up.body.number } });
    const { createMeeting, extractPasted } = await import('../../../domains/meetings/index.js');
    const bm = await createMeeting({ repo: BM, by: 'otra', notes: extractPasted(`De Bmedical. ${notes}`) });
    expect((await call('/api/meetings')).body.meetings.map((m: { number: number }) => m.number)).toEqual([up.body.number]);
    expect((await call('/api/snapshot')).body.reunionesPorRevisar).toBe(0);
    expect((await call(`/api/meetings/${up.body.number}`)).body).toMatchObject({ text: notes, original: false, events: [{ kind: 'uploaded', by: 'valeria' }] });
    expect((await call(`/api/meetings/${bm.number}`)).status).toBe(404);
    expect((await call(`/api/meetings/${bm.number}/original`)).status).toBe(404);
    expect((await call(`/api/meetings/${up.body.number}/original`)).status).toBe(404);
    // ronin reads it as soon as it's up.
    expect(launchMeetingWorker).toHaveBeenCalledWith(up.body.number);
    // Asking again: only after a failed reading, and only for its repos.
    expect((await call(`/api/meetings/${up.body.number}/retry`, 'POST', {})).status).toBe(409);
    const { updateMeeting } = await import('../../../domains/meetings/index.js');
    await updateMeeting(up.body.number, (m) => { m.status = 'failed'; });
    await updateMeeting(bm.number, (m) => { m.status = 'failed'; });
    expect((await call(`/api/meetings/${bm.number}/retry`, 'POST', {})).status).toBe(404);
    expect((await call(`/api/meetings/${bm.number}/approve`, 'POST', { items: [{ id: 'i1' }] })).status).toBe(404);
    expect((await call(`/api/meetings/${bm.number}/discard`, 'POST', {})).status).toBe(404);
    // Nothing to approve yet: it has no proposals.
    expect((await call(`/api/meetings/${up.body.number}/approve`, 'POST', { items: [{ id: 'i1' }] })).status).toBe(409);
    launchMeetingWorker.mockClear();
    expect((await call(`/api/meetings/${up.body.number}/retry`, 'POST', {})).body).toEqual({ ok: true });
    expect(launchMeetingWorker).toHaveBeenCalledWith(up.body.number);
    expect((await call(`/api/meetings/${up.body.number}`)).body).toMatchObject({ status: 'pending', events: [{ kind: 'uploaded' }, { kind: 'retried', by: 'valeria' }] });
  });

  it("reads only a file the PR changes (#111)", async () => {
    expect((await call(`/api/items/${encodeURIComponent(`${SC}#2`)}/files/content?path=.env`)).status).toBe(404);
  });
  it('refuses what a read-only member asks, whatever the page shows (#174)', async () => {
    const readOnly = { admin: false, repos: [{ repo: SC, permission: 'triage' as const, perms: { notas: false, aprobar: false, acciones: false, desplegar: false } }] };
    const refused = async (path: string, body: unknown) => {
      const out = await call(path, 'POST', body, readOnly);
      expect(out.status, path).toBe(403);
      return out.body.error as string;
    };
    expect(await refused(`/api/items/${encodeURIComponent(`${SC}#1`)}/actions`, { action: 'assign' })).toMatch(/acciones del tablero/);
    await refused(`/api/repos/${SC}/issues`, { title: 'x', body: 'y', after: 'none' });
    await refused(`/api/items/${encodeURIComponent(`${SC}#2`)}/files/actions`, { action: 'comment', path: 'a.ts', body: 'x' });
    expect(await refused('/api/meetings', { repo: SC, text: 'notas de la reunión' })).toMatch(/subir notas/);
    await refused(`/api/deploys/${SC}/plan`, { tag: 'v1', prs: 'all' });
    expect((await call('/api/snapshot', 'GET', undefined, readOnly)).body.despliegues).toBe(false);
    expect((await call('/api/settings/users', 'GET', undefined, readOnly)).status).toBe(403);
  });

  it('gives a member only their own profile in Ajustes (#174)', async () => {
    const view = await call('/api/settings');
    expect(view.status).toBe(200);
    expect(view.body.me).toEqual({ login: 'valeria', admin: false });
    expect(view.body.valores).toBeUndefined();
    expect((await call('/api/settings/log')).status).toBe(403);
    expect((await call('/api/settings/values', 'POST', { key: 'portal.dailyLimit', value: 50 })).status).toBe(403);
  });
});

describe('an admin (#222)', () => {
  const ADMIN = { admin: true, repos: [{ repo: SC, permission: 'admin-del-tablero' as const }, { repo: BM, permission: 'admin-del-tablero' as const }] };

  it('gets the metrics of every repo, or of the one asked', async () => {
    expect((await call('/api/metricas', 'GET', undefined, ADMIN as never)).body).toEqual({ repos: [SC, BM], days: 30, repo: null });
    expect((await call(`/api/metricas?dias=7&repo=${encodeURIComponent(BM)}`, 'GET', undefined, ADMIN as never)).body).toEqual({ repos: [SC, BM], days: 7, repo: BM });
  });

  it('is told what it asked wrong', async () => {
    expect((await call('/api/metricas?dias=14', 'GET', undefined, ADMIN as never)).status).toBe(400);
    expect((await call('/api/metricas?repo=otro%2Frepo', 'GET', undefined, ADMIN as never)).status).toBe(404);
  });
});
