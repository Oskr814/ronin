import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostLoad, listRuns, readQueue, readTickInfo, slotsInUse, summarizeRun, type RunLine } from './dashboard-data.js';

let logs: string;
beforeEach(() => {
  logs = mkdtempSync(join(tmpdir(), 'ronin-dash-'));
  process.env.RONIN_LOGS_DIR = logs;
});

const DEAD_PID = 999_999_999;

function start(runId: string, extra: Record<string, unknown> = {}): RunLine {
  return { type: 'run_start', runId, repo: 'acme/product', taskType: 'implement-slice', label: 'issue #879', issueNumber: 879, account: 'redmotos', worktree: '/w', pid: process.pid, startedAt: '2026-10-16T10:00:00.000Z', ...extra };
}

function writeRun(day: string, lines: RunLine[]): void {
  mkdirSync(join(logs, 'runs', day), { recursive: true });
  writeFileSync(join(logs, 'runs', day, `${lines[0].runId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('summarizeRun', () => {
  it('takes its outcome, cost and last step from the record', () => {
    const summary = summarizeRun([
      start('20261016T100000-implement-slice-879-aaaa', { sliceIndex: 1, sliceTitle: 'Validar stock' }),
      { type: 'text', text: 'Arranco' },
      { type: 'tool', name: 'Bash', summary: '$ pnpm test' },
      { type: 'run_end', endedAt: '2026-10-16T10:06:00.000Z', durationMs: 360000, outcome: 'ok', costUsd: 0.4 },
    ]);
    expect(summary).toMatchObject({ state: 'ok', costUsd: 0.4, durationMs: 360000, steps: 2, lastStep: '$ pnpm test', sliceTitle: 'Validar stock' });
  });

  it('keeps the group a run is a step of, and nothing for one that is not', () => {
    expect(summarizeRun([start('20261016T100000-preview-data-triage-849-aaaa', { group: 'preview:849:t' })])?.group).toBe('preview:849:t');
    expect(summarizeRun([start('20261016T100000-x-1-aaaa')])).not.toHaveProperty('group');
  });

  it('tells a run still going from one whose process died without closing it', () => {
    expect(summarizeRun([start('20261016T100000-x-1-aaaa')])?.state).toBe('running');
    expect(summarizeRun([start('20261016T100000-x-1-aaaa', { pid: DEAD_PID })])?.state).toBe('cut');
  });

  it('knows the portal request a run was about, from its record or, for older runs, its label (#132)', () => {
    const portal = (extra: Record<string, unknown>) => summarizeRun([start('20261017T172409-portal-request-ed1b', { issueNumber: undefined, ...extra })])?.portalRequest;
    expect(portal({ taskType: 'portal-request', portalRequest: 7, label: 'pedido P-7' })).toBe(7);
    expect(portal({ taskType: 'portal-request', label: 'pedido P-2' })).toBe(2);
    expect(portal({ taskType: 'portal-prototype', label: 'pedido P-2 (prototipo)' })).toBe(2);
    expect(portal({ taskType: 'fix-issue', label: 'pedido P-2' })).toBeUndefined();
  });

  it('is null for a file that does not start with run_start', () => {
    expect(summarizeRun([{ type: 'text', text: 'x' }])).toBeNull();
  });
});

describe('listRuns', () => {
  it('lists the last days only, newest first', async () => {
    const now = new Date(2026, 9, 16, 12);
    writeRun('2026-10-16', [start('20261016T100000-implement-slice-879-aaaa'), { type: 'run_end', outcome: 'ok', endedAt: '2026-10-16T10:05:00.000Z', durationMs: 1 }]);
    writeRun('2026-10-16', [start('20261016T110000-fix-comments-879-bbbb', { taskType: 'fix-comments', startedAt: '2026-10-16T11:00:00.000Z' })]);
    writeRun('2026-10-15', [start('20261015T090000-external-review-412-cccc', { taskType: 'external-review', issueNumber: undefined, prNumber: 412, startedAt: '2026-10-15T09:00:00.000Z' }), { type: 'run_end', outcome: 'error', endedAt: 'x', durationMs: 1 }]);
    writeRun('2026-10-01', [start('20261001T090000-plan-1-dddd', { startedAt: '2026-10-01T09:00:00.000Z' })]);

    const runs = await listRuns(3, now);
    expect(runs.map((r) => r.runId)).toEqual(['20261016T110000-fix-comments-879-bbbb', '20261016T100000-implement-slice-879-aaaa', '20261015T090000-external-review-412-cccc']);

  });
});

describe('slots, queue and tick', () => {
  it('counts only the slots a live process holds', () => {
    const root = mkdtempSync(join(tmpdir(), 'ronin-root-'));
    mkdirSync(join(root, '.ronin-slots'));
    writeFileSync(join(root, '.ronin-slots', 'all-0.lock'), String(process.pid));
    writeFileSync(join(root, '.ronin-slots', 'all-1.lock'), String(DEAD_PID));
    writeFileSync(join(root, '.ronin-slots', 'kind-changelog-0.lock'), String(process.pid));
    expect(slotsInUse(root)).toEqual({ '': 1 });
  });

  it('counts each repo on its own: every repo is its own queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'ronin-root-'));
    mkdirSync(join(root, '.ronin-slots'));
    const slot = (repo: string, name: string, pid: number) => writeFileSync(join(root, '.ronin-slots', `${encodeURIComponent(repo)}~${name}.lock`), String(pid));
    slot('acme/product', 'all-0', process.pid);
    slot('acme/product', 'all-1', process.pid);
    slot('acme/other', 'all-0', process.pid);
    slot('acme/other', 'all-1', DEAD_PID);
    slot('acme/other', 'kind-external-review-0', process.pid);
    expect(slotsInUse(root)).toEqual({ 'acme/product': 2, 'acme/other': 1 });
  });

  it('lists what waits for a slot, skipping marks of dead processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ronin-root-'));
    mkdirSync(join(root, '.ronin-slots', 'waiting'), { recursive: true });
    writeFileSync(join(root, '.ronin-slots', 'waiting', 'a.json'), JSON.stringify({ pid: process.pid, kind: 'issue', label: 'issue #880', repo: 'acme/product', since: '2026-10-16T10:00:00Z' }));
    writeFileSync(join(root, '.ronin-slots', 'waiting', 'b.json'), JSON.stringify({ pid: DEAD_PID, kind: 'issue', label: 'viejo', since: '2026-10-16T09:00:00Z' }));
    expect(readQueue(root)).toEqual([{ kind: 'issue', label: 'issue #880', repo: 'acme/product', since: '2026-10-16T10:00:00Z' }]);
  });

  it("reads the last tick and event from today's log", () => {
    const now = new Date(2026, 9, 16, 12);
    writeFileSync(join(logs, 'tick-2026-10-16.log'), [
      '{"event":"tick_complete","ts":"2026-10-16T09:00:00.000Z","durationMs":1000}',
      '[2026-10-16T09:30:00.000Z] INFO algo',
      '{"event":"event_complete","ts":"2026-10-16T09:40:00.000Z","durationMs":5}',
      '{"event":"tick_complete","ts":"2026-10-16T09:30:00.000Z","durationMs":2000}',
    ].join('\n'));
    expect(readTickInfo(now)).toEqual({ lastTickAt: '2026-10-16T09:30:00.000Z', lastTickDurationMs: 2000, lastEventAt: '2026-10-16T09:40:00.000Z' });
  });
});

describe('hostLoad', () => {
  it('measures memory by MemAvailable, and CPU between two reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'ronin-host-'));
    const meminfo = join(root, 'meminfo');
    writeFileSync(meminfo, `MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    8000000 kB\n`);
    const first = hostLoad(1_000, meminfo);
    expect(first.memUsedBytes).toBe(Math.max(0, first.memTotalBytes - 8_000_000 * 1024));
    expect(first.cpu).toBeGreaterThanOrEqual(0);
    expect(first.cpu).toBeLessThanOrEqual(1);
    expect(first.cores).toBeGreaterThan(0);
    const second = hostLoad(2_000, meminfo);
    expect(second.cpu).toBeGreaterThanOrEqual(0);
    expect(second.cpu).toBeLessThanOrEqual(1);
  });
});
