import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { config } from '@platform/config/config.js';
import { extractPasted } from './extract.js';
import { createMeeting, getMeeting, updateMeeting } from './meetings.js';
import { retryMeeting, sweepMeetings } from './launch.js';

const NOTES = 'Exportar pedidos: bodega pidió bajar a Excel la lista de pedidos con los filtros puestos.';
const NOW = Date.parse('2026-10-17T20:00:00Z');
const DEAD = 2 ** 22 + 12345;

beforeEach(async () => {
  await rm(config.meetings.dataDir, { recursive: true, force: true });
});

const meeting = async (text: string, change: (m: Parameters<Parameters<typeof updateMeeting>[1]>[0]) => void) => {
  const m = await createMeeting({ repo: 'redmotos/shoppingcart', by: 'a', notes: extractPasted(`${text} ${NOTES}`) }, new Date(NOW - 60 * 60_000));
  await updateMeeting(m.number, change);
  return m.number;
};

describe('sweepMeetings', () => {
  it('relaunches the meetings still to read whose worker is gone, and only those', async () => {
    const dead = await meeting('a', (m) => { m.worker = { pid: DEAD, since: new Date(NOW - 10 * 60_000).toISOString() }; m.status = 'reading'; });
    const alive = await meeting('b', (m) => { m.worker = { pid: process.pid, since: new Date(NOW - 10 * 60_000).toISOString() }; });
    const justLaunched = await meeting('c', (m) => { m.worker = { pid: DEAD, since: new Date(NOW - 30_000).toISOString() }; });
    const done = await meeting('d', (m) => { m.status = 'review'; });
    const failed = await meeting('e', (m) => { m.status = 'failed'; });
    const launch = vi.fn(async () => {});
    await sweepMeetings(NOW, launch);
    expect(launch.mock.calls).toEqual([[dead, 'tick']]);
    expect([alive, justLaunched, done, failed]).toHaveLength(4);
  });

  it('gives a worker that never wrote its pid a grace period after the upload', async () => {
    const n = (await createMeeting({ repo: 'redmotos/shoppingcart', by: 'a', notes: extractPasted(NOTES) })).number;
    const launch = vi.fn(async () => {});
    await sweepMeetings(Date.now(), launch);
    expect(launch).not.toHaveBeenCalled();
    await sweepMeetings(Date.now() + 3 * 60_000, launch);
    expect(launch).toHaveBeenCalledWith(n, 'tick');
  });
});

describe('retryMeeting', () => {
  it('only takes back a failed one', async () => {
    const n = await meeting('a', (m) => { m.status = 'review'; });
    expect(await retryMeeting(n, 'valeria')).toBe(false);
    await updateMeeting(n, (m) => { m.status = 'failed'; });
    expect(await retryMeeting(n, 'valeria')).toBe(true);
    expect((await getMeeting(n))).toMatchObject({ status: 'pending', events: [{ kind: 'uploaded' }, { kind: 'retried', by: 'valeria' }] });
  });
});
