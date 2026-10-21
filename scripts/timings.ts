// `pnpm timings [días]`: how long the API's routes and the tick's steps
// took over the last days (7 by default), from logs/timings/ and the tick
// logs — the baseline of #235. Read only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay, logsDir } from '@platform/agents/run-files.js';
import { timingsPath, type RouteWindow } from '@platform/timing.js';
import { ms, summarizeRoutes, summarizeTicks, tickMetricsOf } from '@platform/timing-report.js';

const days = Number(process.argv[2]) || 7;
const dates = Array.from({ length: days }, (_, i) => localDay(new Date(Date.now() - i * 86_400_000)));

const windows: RouteWindow[] = [];
for (const day of dates) {
  const path = timingsPath(day);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      windows.push(JSON.parse(line) as RouteWindow);
    } catch {
      // Half a line.
    }
  }
}

const ticks = dates.flatMap((day) => {
  const path = join(logsDir(), `tick-${day}.log`);
  return existsSync(path) ? tickMetricsOf(readFileSync(path, 'utf8')) : [];
});

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`\nRequests de la API, últimos ${days} días (percentiles por tramo: «≤ 250 ms»)\n`);
const routes = summarizeRoutes(windows);
if (!routes.length) console.log('  Todavía no hay datos en logs/timings/.');
else {
  console.log(`  ${pad('listener', 9)} ${pad('método', 6)} ${pad('ruta', 52)} ${lpad('n', 6)} ${lpad('prom.', 8)} ${lpad('p50', 8)} ${lpad('p90', 8)} ${lpad('p99', 8)} ${lpad('máx', 8)} ${lpad('GitHub', 8)} ${lpad('llam.', 5)} ${lpad('5xx', 4)}`);
  for (const r of routes) {
    console.log(`  ${pad(r.listener, 9)} ${pad(r.method, 6)} ${pad(r.route.slice(0, 52), 52)} ${lpad(r.count, 6)} ${lpad(ms(r.avgMs), 8)} ${lpad(`≤${ms(r.p50)}`, 8)} ${lpad(`≤${ms(r.p90)}`, 8)} ${lpad(`≤${ms(r.p99)}`, 8)} ${lpad(ms(r.maxMs), 8)} ${lpad(ms(r.githubMs), 8)} ${lpad(r.githubCalls.toFixed(1), 5)} ${lpad(r.errors, 4)}`);
  }
}

console.log(`\nTicks, últimos ${days} días (medianas)\n`);
const summaries = summarizeTicks(ticks);
if (!summaries.length) console.log('  Todavía no hay ticks medidos.');
for (const t of summaries) {
  console.log(`  ${t.repo}: ${t.ticks} ticks · total p50 ${ms(t.p50)}, p90 ${ms(t.p90)}, máx ${ms(t.max)}`);
  if (t.discoveryMs !== null) console.log(`    descubrimiento ${ms(t.discoveryMs)} · trabajos ${ms(t.jobsMs)} · GitHub ${ms(t.githubMs)} en ${t.githubCalls} llamadas`);
  const steps = Object.entries(t.steps).map(([name, v]) => `${name} ${ms(v)}`).join(' · ');
  if (steps) console.log(`    pasos: ${steps}`);
}
console.log('');
