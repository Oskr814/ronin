import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: Record<string, string> = {};
let explore: string[] | undefined = ['backoffice', 'tienda'];
const busy = vi.fn();
const launch = vi.fn();
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', explore }) }));
vi.mock('./config.js', () => ({ config: { exploreNightWindow: '23:00-05:00', exploreFunctionsPerNight: 4 } }));
vi.mock('./local-state.js', () => ({
  getNightlyExploration: async () => ({ ...state }),
  setNightlyExploration: async (app: string, night: string) => { state[app] = night; },
}));
vi.mock('./exploration-flow.js', () => ({
  exploreWorkerBusy: (...args: unknown[]) => busy(...args),
  launchExploreWorker: (...args: unknown[]) => launch(...args),
}));

import { currentNight, maybeLaunchNightlyExploration, nextNightlyApp, parseNightWindow } from './exploration-schedule.js';

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
    expect(currentNight(new Date(2026, 9, 12, 0, 59), window)).toBeNull();
    expect(currentNight(new Date(2026, 9, 12, 6, 0), window)).toBeNull();
    expect(currentNight(new Date(2026, 9, 12, 22, 0), crossing)).toBeNull();
  });

  it('gives the night and its end inside the window', () => {
    const t = currentNight(new Date(2026, 9, 12, 3, 30), window)!;
    expect(t.night).toBe('2026-10-12');
    expect(t.end).toEqual(new Date(2026, 9, 12, 6, 0));
  });

  it('treats a window across midnight as one night', () => {
    const before = currentNight(new Date(2026, 9, 12, 23, 30), crossing)!;
    const after = currentNight(new Date(2026, 9, 13, 2, 0), crossing)!;
    expect(before.night).toBe('2026-10-12');
    expect(after.night).toBe('2026-10-12');
    expect(before.end).toEqual(new Date(2026, 9, 13, 5, 0));
    expect(after.end).toEqual(new Date(2026, 9, 13, 5, 0));
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
    const night = new Date(2026, 9, 12, 23, 30);
    await maybeLaunchNightlyExploration(night);
    await maybeLaunchNightlyExploration(night);
    await maybeLaunchNightlyExploration(night);
    expect(launch.mock.calls.map(([r]) => r.appName)).toEqual(['backoffice', 'tienda']);
    expect(launch.mock.calls[0][0]).toEqual({ repo: 'redmotos/shoppingcart', appName: 'backoffice', maxFunctions: 4, until: new Date(2026, 9, 13, 5, 0).toISOString() });
  });

  it('does nothing by day, while a worker runs, or for a repo without nightly apps', async () => {
    await maybeLaunchNightlyExploration(new Date(2026, 9, 12, 12, 0));
    busy.mockResolvedValue(true);
    await maybeLaunchNightlyExploration(new Date(2026, 9, 12, 23, 30));
    busy.mockResolvedValue(false);
    explore = undefined;
    await maybeLaunchNightlyExploration(new Date(2026, 9, 12, 23, 30));
    expect(launch).not.toHaveBeenCalled();
  });
});
