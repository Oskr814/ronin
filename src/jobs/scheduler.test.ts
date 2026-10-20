import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastBoundary, pruneLogs, tickDue } from './scheduler.js';

const at = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00`);

describe('the tick times', () => {
  it('are counted from the hour: every 30 minutes is :00 and :30', () => {
    expect(lastBoundary(at('10:00'), 30)).toEqual(at('10:00'));
    expect(lastBoundary(at('10:29'), 30)).toEqual(at('10:00'));
    expect(lastBoundary(at('10:31'), 30)).toEqual(at('10:30'));
    expect(lastBoundary(at('10:59'), 15)).toEqual(at('10:45'));
    expect(lastBoundary(at('13:10'), 120)).toEqual(at('12:00'));
  });

  it('a tick is due when none was queued or started since the last time', () => {
    expect(tickDue(at('10:31'), 30, null)).toBe(true);
    expect(tickDue(at('10:31'), 30, at('10:29'))).toBe(true);
    expect(tickDue(at('10:31'), 30, at('10:30'))).toBe(false);
    expect(tickDue(at('10:59'), 30, at('10:30'))).toBe(false);
    expect(tickDue(at('11:00'), 30, at('10:30'))).toBe(true);
  });
});

describe('pruneLogs', () => {
  it('takes out the tick logs and run folders older than 14 days, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ronin-prune-'));
    const now = Date.parse('2026-10-20T12:00:00Z');
    const old = new Date(now - 20 * 86_400_000);
    for (const name of ['tick-2026-09-30.log', 'tick-2026-10-19.log', 'otro.log']) writeFileSync(join(dir, name), 'x');
    mkdirSync(join(dir, 'runs', '2026-09-30'), { recursive: true });
    mkdirSync(join(dir, 'runs', '2026-10-19'), { recursive: true });
    utimesSync(join(dir, 'tick-2026-09-30.log'), old, old);
    utimesSync(join(dir, 'otro.log'), old, old);
    utimesSync(join(dir, 'runs', '2026-09-30'), old, old);
    expect(await pruneLogs(dir, now)).toBe(2);
    expect(['tick-2026-09-30.log', 'tick-2026-10-19.log', 'otro.log', 'runs/2026-09-30', 'runs/2026-10-19'].map((p) => existsSync(join(dir, p)))).toEqual([false, true, true, false, true]);
  });
});
