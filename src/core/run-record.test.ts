import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecord } from './run-record.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ronin-runs-'));
  process.env.RONIN_LOGS_DIR = dir;
});

const CONTEXT = {
  repo: 'redmotos/shoppingcart',
  taskType: 'implement-slice',
  label: 'issue #879',
  issueNumber: 879,
  sliceIndex: 1,
  sliceTitle: 'Validar stock',
  model: 'opus',
  account: 'redmotos',
  worktree: '/w/ronin/879/slice-2',
};

function lines(record: RunRecord): any[] {
  return readFileSync(record.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('RunRecord', () => {
  it('writes one file per run under logs/runs/<day>/', () => {
    const record = RunRecord.start(CONTEXT, new Date(2026, 9, 16, 1, 31, 58));
    expect(record.path.startsWith(join(dir, 'runs', '2026-10-16'))).toBe(true);
    expect(record.runId).toMatch(/^20261016T013158-implement-slice-879-[0-9a-f]{4}$/);
  });

  it('starts with what the run is about and the pid that runs it', () => {
    const record = RunRecord.start(CONTEXT);
    expect(lines(record)[0]).toMatchObject({ type: 'run_start', runId: record.runId, ...CONTEXT, pid: process.pid });
  });

  it('adds the steps as they happen and ends with the outcome and totals', () => {
    const start = new Date('2026-10-16T01:00:00Z');
    const record = RunRecord.start(CONTEXT, start);
    record.step({ kind: 'text', text: 'Arranco la slice 2' });
    record.step({ kind: 'tool', name: 'Bash', summary: '$ pnpm test' });
    record.step({ kind: 'tool_error', text: '1 test falla' });
    record.result({ sessionId: 's1', costUsd: 0.42, outputTokens: 900 });
    record.end('ok', undefined, new Date('2026-10-16T01:06:00Z'));

    const [, text, tool, toolError, end] = lines(record);
    expect(text).toMatchObject({ type: 'text', text: 'Arranco la slice 2' });
    expect(text).not.toHaveProperty('kind');
    expect(tool).toMatchObject({ type: 'tool', name: 'Bash', summary: '$ pnpm test' });
    expect(toolError).toMatchObject({ type: 'tool_error', text: '1 test falla' });
    expect(end).toEqual({
      type: 'run_end',
      endedAt: '2026-10-16T01:06:00.000Z',
      durationMs: 6 * 60_000,
      outcome: 'ok',
      sessionId: 's1',
      costUsd: 0.42,
      outputTokens: 900,
    });
  });

  it("keeps the error's message on a failed run", () => {
    const record = RunRecord.start(CONTEXT);
    record.end('timeout', new Error('claude timed out after 1800000ms'));
    expect(lines(record).at(-1)).toMatchObject({ outcome: 'timeout', error: 'claude timed out after 1800000ms' });
  });

  it('redacts secrets in any field, and every line stays valid JSON', () => {
    const record = RunRecord.start(CONTEXT);
    record.step({ kind: 'tool', name: 'Bash', summary: '$ curl -H "Authorization: Bearer abcdefghijklmnop" https://api' });
    record.step({ kind: 'text', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 en la salida' });
    const raw = readFileSync(record.path, 'utf8');
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(lines(record)).toHaveLength(3);
  });

  it('never throws when it cannot write', () => {
    // A file where the logs dir should be: every write fails.
    const notADir = join(dir, 'not-a-dir');
    writeFileSync(notADir, '');
    process.env.RONIN_LOGS_DIR = notADir;
    const record = RunRecord.start(CONTEXT);
    expect(() => {
      record.step({ kind: 'text', text: 'x' });
      record.end('ok');
    }).not.toThrow();
  });
});
