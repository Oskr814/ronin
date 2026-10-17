import { describe, it, expect } from 'vitest';
import type { RunSummary } from './dashboard-data.js';
import { dayTotals, today } from './dashboard-today.js';

function run(fields: Partial<RunSummary>): RunSummary {
  return { runId: 'r', repo: 'acme/product', taskType: 'implement-slice', label: 'x', account: 'a', worktree: '/w', startedAt: '2026-10-16T10:00:00Z', state: 'ok', steps: 1, ...fields };
}

describe('dayTotals', () => {
  it('counts outcomes over finished runs, with duration percentiles and cost', () => {
    const totals = dayTotals([
      run({ state: 'ok', durationMs: 60_000, costUsd: 0.5 }),
      run({ state: 'ok', durationMs: 120_000, costUsd: 0.25 }),
      run({ state: 'error', durationMs: 600_000 }),
      run({ state: 'cut' }),
      run({ state: 'usage_limit', durationMs: 5_000 }),
      run({ state: 'running' }),
    ]);
    expect(totals).toEqual({ runs: 6, finished: 5, ok: 2, failed: 2, usageLimit: 1, medianMs: 60_000, p90Ms: 600_000, costUsd: 0.75 });
  });

  it('has no percentiles without durations', () => {
    expect(dayTotals([])).toMatchObject({ runs: 0, medianMs: null, p90Ms: null, costUsd: 0 });
  });
});

describe('today', () => {
  it("keeps the last 12 hours for the timeline, and totals today's and yesterday's runs", () => {
    const now = new Date(2026, 9, 16, 12, 0);
    const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m).toISOString();
    const result = today([
      run({ runId: 'live', issueNumber: 879, startedAt: at(11, 50), state: 'running' }),
      run({ runId: 'morning', prNumber: 412, startedAt: at(8), endedAt: at(8, 10), durationMs: 600_000 }),
      run({ runId: 'old-but-ended-late', startedAt: new Date(2026, 9, 15, 23, 50).toISOString(), endedAt: at(0, 20), durationMs: 1_800_000 }),
      run({ runId: 'too-old', startedAt: new Date(2026, 9, 15, 20).toISOString(), endedAt: new Date(2026, 9, 15, 20, 5).toISOString() }),
    ], now);
    expect(result.timeline.map((r) => [r.runId, r.itemId])).toEqual([
      ['old-but-ended-late', 'acme/product:implement-slice:x'],
      ['morning', 'acme/product#412'],
      ['live', 'acme/product#879'],
    ]);
    expect(result.today).toMatchObject({ runs: 2, finished: 1, ok: 1 });
    expect(result.yesterday).toEqual({ runs: 2, ok: 2, finished: 2, costUsd: 0 });
    expect(result.from).toBe(new Date(2026, 9, 16, 0).toISOString());
  });

  it("totals each of the week's days, oldest first and today last", () => {
    const now = new Date(2026, 9, 16, 12, 0);
    const result = today([
      run({ startedAt: new Date(2026, 9, 16, 9).toISOString(), durationMs: 60_000, costUsd: 1 }),
      run({ startedAt: new Date(2026, 9, 13, 9).toISOString(), state: 'error', durationMs: 120_000 }),
      run({ startedAt: new Date(2026, 9, 1, 9).toISOString() }),
    ], now);
    expect(result.week).toHaveLength(7);
    expect(result.week[6]).toMatchObject({ runs: 1, ok: 1, finished: 1, medianMs: 60_000, costUsd: 1 });
    expect(result.week[3]).toMatchObject({ runs: 1, ok: 0, finished: 1 });
    expect(result.week.reduce((sum, d) => sum + d.runs, 0)).toBe(2);
  });
});
