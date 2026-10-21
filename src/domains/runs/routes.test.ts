import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Access } from '../access/access.js';

vi.mock('../../platform/config/repos.js', () => ({ loadRepos: async () => [{ productRepo: 'acme/tienda', productRepoPath: '/x' }] }));

const { logsDir } = await import('../../platform/agents/run-files.js');
const { dashboardApp } = await import('../../apps/api/routes.js');
const { answer } = await import('../../apps/api/http/hono.js');

const ACCESS: Access = { admin: false, repos: [{ repo: 'acme/tienda', permission: 'triage' }] };
const RUN = '20261021T030000-fix-issue-12-abcd';
const OTHER = '20261021T030100-fix-issue-13-dcba';
const file = (id: string) => join(logsDir(), 'runs', '2026-10-21', `${id}.jsonl`);
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const start = (id: string, repo: string) => ({ type: 'run_start', runId: id, repo, taskType: 'fix-issue', label: 'issue #12', account: 'acme', worktree: '/w', pid: process.pid, startedAt: '2026-10-21T03:00:00.000Z' });

// Through answer() on a real server, as the dashboard serves it.
let server: Server;
let base: string;
beforeAll(async () => {
  mkdirSync(join(logsDir(), 'runs', '2026-10-21'), { recursive: true });
  writeFileSync(file(RUN), line(start(RUN, 'acme/tienda')) + line({ type: 'text', ts: 'x', text: 'Arranco' }));
  writeFileSync(file(OTHER), line(start(OTHER, 'otra/cosa')));
  server = createServer((req, res) => void answer(dashboardApp, req, res, { session: { login: 'oskr814', token: 't' }, access: ACCESS }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('a run from the dashboard, in Hono', () => {
  it('gives its transcript only to who sees its repo', async () => {
    const res = await fetch(`${base}/api/runs/${RUN}`);
    expect(await res.json()).toMatchObject({ summary: { runId: RUN, state: 'running', steps: 1 }, lines: [{ type: 'run_start' }, { type: 'text' }] });
    expect((await fetch(`${base}/api/runs/${OTHER}`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/${OTHER}/stream`)).status).toBe(404);
    expect((await fetch(`${base}/api/evidence/acme/tienda/abc1234/a.png`)).status).toBe(404);
  });

  it('streams the rest of it as it happens, and says how it ended', async () => {
    const res = await fetch(`${base}/api/runs/${RUN}/stream?from=1`);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (what: string) => {
      while (!text.includes(what)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until('Arranco');
    expect(text).not.toContain('run_start');
    appendFileSync(file(RUN), line({ type: 'tool', ts: 'y', name: 'Bash', summary: '$ pnpm test' }));
    await until('pnpm test');
    appendFileSync(file(RUN), line({ type: 'run_end', endedAt: '2026-10-21T03:05:00.000Z', durationMs: 300000, outcome: 'ok' }));
    await until('event: end');
    expect(text).toContain('event: end\ndata: "ok"');
  });
});
