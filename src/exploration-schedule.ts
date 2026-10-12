import { activeRepo } from './repo-context.js';
import { config } from './config.js';
import { log } from './logger.js';
import { getNightlyExploration, setNightlyExploration } from './local-state.js';
import { exploreWorkerBusy, launchExploreWorker } from './exploration-flow.js';

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

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// If `now` falls inside the window: which night it belongs to (the local
// date the window started on, so 23:00-05:00 is one night across midnight)
// and when it ends. Null outside the window.
export function currentNight(now: Date, window: NightWindow): { night: string; end: Date } | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const crosses = window.endMinutes <= window.startMinutes;
  const inside = crosses
    ? minutes >= window.startMinutes || minutes < window.endMinutes
    : minutes >= window.startMinutes && minutes < window.endMinutes;
  if (!inside) return null;
  const started = new Date(now);
  if (crosses && minutes < window.endMinutes) started.setDate(started.getDate() - 1);
  const end = new Date(started);
  end.setHours(Math.floor(window.endMinutes / 60), window.endMinutes % 60, 0, 0);
  if (crosses) end.setDate(end.getDate() + 1);
  return { night: localDate(started), end };
}

// The next app of this repo due tonight, or null.
export function nextNightlyApp(apps: string[], done: Record<string, string>, night: string): string | null {
  return apps.find((app) => done[app] !== night) ?? null;
}

export async function maybeLaunchNightlyExploration(now = new Date()): Promise<void> {
  const apps = activeRepo().explore ?? [];
  if (apps.length === 0) return;
  const tonight = currentNight(now, parseNightWindow(config.exploreNightWindow));
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
