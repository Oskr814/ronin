import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountName, readAccountUsage, recordRateLimit, recordUsageLimitHit } from './claude-usage.js';

beforeEach(() => {
  process.env.RONIN_LOGS_DIR = mkdtempSync(join(tmpdir(), 'ronin-usage-'));
});

// The shape claude -p sends (seen on 2026-10-16).
const INFO = {
  status: 'allowed',
  resetsAt: 1792116600,
  rateLimitType: 'five_hour',
  unifiedWindows: {
    five_hour: { utilization: 0.4, resetsAt: 1792116600 },
    seven_day: { utilization: 0.17, resetsAt: 1792544400 },
  },
};

describe('accountName', () => {
  it('names the account after its config dir', () => {
    expect(accountName('/home/link/.claude-redmotos')).toBe('redmotos');
    expect(accountName('/home/link/.claude-bmedical/')).toBe('bmedical');
  });

  it("is 'default' for Claude Code's own config", () => {
    expect(accountName('')).toBe('default');
    expect(accountName('/home/link/.claude')).toBe('default');
  });
});

describe('recordRateLimit', () => {
  it("keeps the account's 5-hour and weekly windows, with when they were measured", () => {
    recordRateLimit('/home/link/.claude-redmotos', INFO, new Date('2026-10-16T01:40:00Z'));
    expect(readAccountUsage('redmotos')).toEqual({
      account: 'redmotos',
      claudeConfigDir: '/home/link/.claude-redmotos',
      measuredAt: '2026-10-16T01:40:00.000Z',
      status: 'allowed',
      fiveHour: { utilization: 0.4, resetsAt: new Date(1792116600 * 1000).toISOString() },
      sevenDay: { utilization: 0.17, resetsAt: new Date(1792544400 * 1000).toISOString() },
    });
  });

  it('skips a window that does not come with the event', () => {
    recordRateLimit('/x/.claude-a', { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792116600 } } });
    const usage = readAccountUsage('a');
    expect(usage?.fiveHour?.utilization).toBe(0.1);
    expect(usage).not.toHaveProperty('sevenDay');
  });

  it('never throws on an event it does not understand', () => {
    expect(() => recordRateLimit('/x/.claude-a', undefined)).not.toThrow();
    expect(readAccountUsage('a')).toMatchObject({ account: 'a' });
  });
});

describe('recordUsageLimitHit', () => {
  it('marks the account out of quota, keeping its last windows', () => {
    recordRateLimit('/x/.claude-a', INFO, new Date('2026-10-16T01:40:00Z'));
    recordUsageLimitHit('/x/.claude-a', new Date('2026-10-16T02:00:00Z'));
    expect(readAccountUsage('a')).toMatchObject({ limitHitAt: '2026-10-16T02:00:00.000Z', fiveHour: { utilization: 0.4 } });
  });

  it('is cleared by the next measurement', () => {
    recordUsageLimitHit('/x/.claude-a');
    recordRateLimit('/x/.claude-a', INFO);
    expect(readAccountUsage('a')).not.toHaveProperty('limitHitAt');
  });
});
