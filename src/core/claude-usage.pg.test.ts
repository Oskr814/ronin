import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDb, type Db } from '../db/db.js';
import { TEST_DATABASE_URL, testDb } from '../db/testing.js';
import { listUsage, recordRateLimit, recordUsageLimitHit, usageHistory } from './claude-usage.js';

// The usage of the Claude accounts in Postgres (#235, stage 3.5).
describe.skipIf(!TEST_DATABASE_URL)('the usage of the accounts', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('claude_usage').execute();
    await db.deleteFrom('claude_usage_history').execute();
  });

  const info = (used: number) => ({ status: 'allowed', unifiedWindows: { five_hour: { utilization: used, resetsAt: 1792116600 }, seven_day: { utilization: 0.17, resetsAt: 1792544400 } } });

  it('keeps the last measurement of each account, and every one in its history', async () => {
    await recordRateLimit('/home/x/.claude-redmotos', info(0.2), new Date('2026-10-16T01:00:00Z'));
    await recordRateLimit('/home/x/.claude-redmotos', info(0.4), new Date('2026-10-16T02:00:00Z'));
    await recordRateLimit('/home/x/.claude-bmedical', info(0.1), new Date('2026-10-16T02:00:00Z'));
    expect((await listUsage()).map((u) => [u.account, u.fiveHour?.utilization])).toEqual([['bmedical', 0.1], ['redmotos', 0.4]]);
    expect((await usageHistory('redmotos')).map((m) => m.fiveHour?.utilization)).toEqual([0.2, 0.4]);
  });

  it('marks the limit hit on top of the last measurement, and the next measurement clears it', async () => {
    await recordUsageLimitHit('/home/x/.claude-a', new Date('2026-10-16T01:00:00Z'));
    expect(await listUsage()).toEqual([{ account: 'a', claudeConfigDir: '/home/x/.claude-a', measuredAt: '2026-10-16T01:00:00.000Z', limitHitAt: '2026-10-16T01:00:00.000Z' }]);
    await recordRateLimit('/home/x/.claude-a', info(0.4), new Date('2026-10-16T02:00:00Z'));
    await recordUsageLimitHit('/home/x/.claude-a', new Date('2026-10-16T03:00:00Z'));
    expect((await listUsage())[0]).toMatchObject({ limitHitAt: '2026-10-16T03:00:00.000Z', fiveHour: { utilization: 0.4 } });
    await recordRateLimit('/home/x/.claude-a', info(0.5), new Date('2026-10-16T04:00:00Z'));
    expect((await listUsage())[0]).not.toHaveProperty('limitHitAt');
    expect((await usageHistory('a')).map((m) => (m.limitHit ? 'limit' : m.fiveHour?.utilization))).toEqual(['limit', 0.4, 'limit', 0.5]);
  });
});
