import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: Record<string, string> = {};
let explore: string[] | undefined = ['backoffice', 'tienda'];
const busy = vi.fn();
const launch = vi.fn();
vi.mock('../../platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', explore }) }));
vi.mock('../../platform/config/config.js', () => ({ config: { exploreNightWindow: '23:00-05:00', exploreFunctionsPerNight: 4, exploreTimezone: 'America/Tegucigalpa' } }));
vi.mock('../../platform/state/local-state.js', () => ({
  getNightlyExploration: async () => ({ ...state }),
  setNightlyExploration: async (app: string, night: string) => { state[app] = night; },
}));
vi.mock('./flow.js', () => ({
  exploreWorkerBusy: (...args: unknown[]) => busy(...args),
  launchExploreWorker: (...args: unknown[]) => launch(...args),
}));

import { currentNight, maybeLaunchNightlyExploration, nextNightlyApp, parseNightWindow, upcomingNight } from './schedule.js';

// Times in the exploration's zone (UTC-6, no DST), whatever the server's is.
const TZ = 'America/Tegucigalpa';
const teg = (day: number, hour: number, minute: number) =>
  new Date(`2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-06:00`);

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
  explore = ['backoffice', 'tienda'];
  busy.mockReset().mockResolvedValue(false);
  launch.mockReset();
});

describe('parseNightWindow', () => {
  it('parses HH:MM-HH:MM and rejects anything else', () => {
    expect(parseNightWindow('01:00-06:00')).toEqual({ startMinutes: 60, endMinutes: 360 });
    expect(parseNightWindow(' 23:30 - 5:15 ')).toEqual({ startMinutes: 1410, endMinutes: 315 });
    expect(() => parseNightWindow('de noche')).toThrow(/HH:MM-HH:MM/);
    expect(() => parseNightWindow('25:00-06:00')).toThrow();
  });
});

describe('currentNight', () => {
  const window = parseNightWindow('01:00-06:00');
  const crossing = parseNightWindow('23:00-05:00');

  it('is null outside the window', () => {
    expect(currentNight(teg(12, 0, 59), window, TZ)).toBeNull();
    expect(currentNight(teg(12, 6, 0), window, TZ)).toBeNull();
    expect(currentNight(teg(12, 22, 0), crossing, TZ)).toBeNull();
  });

  it('gives the night and its end inside the window', () => {
    const t = currentNight(teg(12, 3, 30), window, TZ)!;
    expect(t.night).toBe('2026-10-12');
    expect(t.end).toEqual(teg(12, 6, 0));
  });

  it('treats a window across midnight as one night', () => {
    const before = currentNight(teg(12, 23, 30), crossing, TZ)!;
    const after = currentNight(teg(13, 2, 0), crossing, TZ)!;
    expect(before.night).toBe('2026-10-12');
    expect(after.night).toBe('2026-10-12');
    expect(before.end).toEqual(teg(13, 5, 0));
    expect(after.end).toEqual(teg(13, 5, 0));
  });
});

describe('currentNight across zones', () => {
  it('reads the window in the exploration zone, not the server’s', () => {
    const window = parseNightWindow('01:00-06:00');
    // 07:30 UTC is 01:30 in Tegucigalpa: inside; in UTC it would be outside.
    const now = new Date('2026-10-12T07:30:00Z');
    expect(currentNight(now, window, 'UTC')).toBeNull();
    expect(currentNight(now, window, TZ)).toEqual({ night: '2026-10-12', end: new Date('2026-10-12T12:00:00Z') });
  });

  it('handles a window ending at 24:00 and a zone with DST', () => {
    expect(currentNight(new Date('2026-10-12T05:00:00Z'), parseNightWindow('22:00-24:00'), TZ)!.end).toEqual(new Date('2026-10-12T06:00:00Z'));
    // Madrid leaves summer time on 2026-10-25 at 03:00: 06:00 that day is UTC+1.
    expect(currentNight(new Date('2026-10-25T02:30:00Z'), parseNightWindow('01:00-06:00'), 'Europe/Madrid')!.end).toEqual(new Date('2026-10-25T05:00:00Z'));
  });
});

describe('nextNightlyApp', () => {
  it('picks the first app not started tonight', () => {
    expect(nextNightlyApp(['a', 'b'], { a: '2026-10-12' }, '2026-10-12')).toBe('b');
    expect(nextNightlyApp(['a', 'b'], { a: '2026-10-11', b: '2026-10-12' }, '2026-10-12')).toBe('a');
    expect(nextNightlyApp(['a'], { a: '2026-10-12' }, '2026-10-12')).toBeNull();
  });
});

describe('maybeLaunchNightlyExploration', () => {
  it('starts one app per tick, each once per night, until the window ends', async () => {
    const night = teg(12, 23, 30);
    await maybeLaunchNightlyExploration(night);
    await maybeLaunchNightlyExploration(night);
    await maybeLaunchNightlyExploration(night);
    expect(launch.mock.calls.map(([r]) => r.appName)).toEqual(['backoffice', 'tienda']);
    expect(launch.mock.calls[0][0]).toEqual({ repo: 'redmotos/shoppingcart', appName: 'backoffice', maxFunctions: 4, until: teg(13, 5, 0).toISOString() });
  });

  it('does nothing by day, while a worker runs, or for a repo without nightly apps', async () => {
    await maybeLaunchNightlyExploration(teg(12, 12, 0));
    busy.mockResolvedValue(true);
    await maybeLaunchNightlyExploration(teg(12, 23, 30));
    busy.mockResolvedValue(false);
    explore = undefined;
    await maybeLaunchNightlyExploration(teg(12, 23, 30));
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('upcomingNight', () => {
  const window = parseNightWindow('23:00-05:00');
  const tz = 'America/Tegucigalpa';

  it('is the night going on inside the window, across midnight', () => {
    expect(upcomingNight(new Date('2026-10-19T08:00:00Z'), window, tz)).toBe('2026-10-18'); // 02:00 local
    expect(upcomingNight(new Date('2026-10-19T05:30:00Z'), window, tz)).toBe('2026-10-18'); // 23:30 local
  });

  it('is today’s during the day', () => {
    expect(upcomingNight(new Date('2026-10-18T22:50:00Z'), window, tz)).toBe('2026-10-18'); // 16:50 local
  });

  it('is tomorrow’s once today’s window has gone by, for one that doesn’t cross midnight', () => {
    expect(upcomingNight(new Date('2026-10-18T22:50:00Z'), parseNightWindow('01:00-06:00'), tz)).toBe('2026-10-19');
    expect(upcomingNight(new Date('2026-10-19T06:30:00Z'), parseNightWindow('01:00-06:00'), tz)).toBe('2026-10-19'); // 00:30 local
  });
});
