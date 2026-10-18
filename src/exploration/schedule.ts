import { activeRepo } from '../core/repo-context.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { getNightlyExploration, setNightlyExploration } from '../core/local-state.js';
import { exploreWorkerBusy, launchExploreWorker } from './flow.js';
import { addDays, instantAt, wallClock } from '../core/timezone.js';

// Nightly exploration — docs/DESIGN.md §11.8. No cron of its own: every tick
// asks "is it night, and is there an app of this repo not explored yet
// tonight?", and if so starts the worker for it (a separate process, so the
// tick keeps handling urgent work meanwhile). One app at a time per repo
// (the worker's lock), each started at most once per night.

export interface NightWindow {
  startMinutes: number;
  endMinutes: number;
}

export function parseNightWindow(value: string): NightWindow {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`EXPLORE_NIGHT_WINDOW inválida: "${value}" (formato HH:MM-HH:MM)`);
  const [h1, m1, h2, m2] = match.slice(1).map(Number);
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59) throw new Error(`EXPLORE_NIGHT_WINDOW inválida: "${value}"`);
  return { startMinutes: h1 * 60 + m1, endMinutes: h2 * 60 + m2 };
}

// If `now` falls inside the window, read in `timezone`: which night it
// belongs to (the date the window started on, so 23:00-05:00 is one night
// across midnight) and when it ends. Null outside the window.
export function currentNight(now: Date, window: NightWindow, timezone: string): { night: string; end: Date } | null {
  const { day, minutes } = wallClock(now, timezone);
  const crosses = window.endMinutes <= window.startMinutes;
  const inside = crosses
    ? minutes >= window.startMinutes || minutes < window.endMinutes
    : minutes >= window.startMinutes && minutes < window.endMinutes;
  if (!inside) return null;
  const night = crosses && minutes < window.endMinutes ? addDays(day, -1) : day;
  return { night, end: instantAt(crosses ? addDays(night, 1) : night, window.endMinutes, timezone) };
}

// The next app of this repo due tonight, or null.
export function nextNightlyApp(apps: string[], done: Record<string, string>, night: string): string | null {
  return apps.find((app) => done[app] !== night) ?? null;
}

// The night a run started now stands for (#155): tonight's while the window
// is open, else the next one to open — today's, or tomorrow's once today's
// start went by.
export function upcomingNight(now: Date, window: NightWindow, timezone: string): string {
  const tonight = currentNight(now, window, timezone);
  if (tonight) return tonight.night;
  const { day, minutes } = wallClock(now, timezone);
  return minutes < window.startMinutes ? day : addDays(day, 1);
}

export async function maybeLaunchNightlyExploration(now = new Date()): Promise<void> {
  const apps = activeRepo().explore ?? [];
  if (apps.length === 0) return;
  const tonight = currentNight(now, parseNightWindow(config.exploreNightWindow), config.exploreTimezone);
  if (!tonight) return;
  if (await exploreWorkerBusy()) return;
  const app = nextNightlyApp(apps, await getNightlyExploration(), tonight.night);
  if (!app) return;
  await setNightlyExploration(app, tonight.night);
  log.info(`exploración nocturna: ${app} (noche ${tonight.night}, hasta ${tonight.end.toLocaleTimeString()})`);
  launchExploreWorker({
    repo: activeRepo().productRepo,
    appName: app,
    maxFunctions: config.exploreFunctionsPerNight,
    until: tonight.end.toISOString(),
  });
}
