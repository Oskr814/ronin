import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../../../platform/logger.js';
import { measure, routeOf, RouteTimings, serverTiming, spansOf, writeTimings } from '../../../platform/timing.js';

// Every request of the API, measured (#235, stage 1): a Server-Timing header
// on its answer, a log line when it's slow, and a summary per route every
// few minutes in logs/timings/<day>.jsonl (scripts/timings.ts reads it).
// The web app's files and anything outside /api go through untouched.

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 500;
const FLUSH_MS = 10 * 60_000;

const routes = new RouteTimings();
let flushing: NodeJS.Timeout | undefined;

// The summaries are written from the first measured request on, so a test
// that never measures one leaves no timer behind.
function startFlushing(): void {
  if (flushing) return;
  flushing = setInterval(() => writeTimings(routes.flush()), FLUSH_MS);
  flushing.unref();
}

const streams = (headers: unknown) => typeof headers === 'object' && headers !== null
  && Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'content-type' && String(value).includes('event-stream'));

export function timedRequests(listener: string, handle: Handler, timings = routes): Handler {
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return handle(req, res);
    if (timings === routes) startFlushing();
    return measure(async (measurement) => {
      // A live stream (a run followed from the dashboard) stays open on
      // purpose: it's neither slow nor part of the summary.
      let stream = false;
      // Every answer goes through writeHead, also one that only calls end():
      // the header is set right before it, with the time up to then.
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      res.writeHead = ((...args: unknown[]) => {
        stream = args.some(streams);
        if (!res.headersSent) res.setHeader('Server-Timing', serverTiming(measurement));
        return writeHead(...args);
      }) as typeof res.writeHead;
      res.once('finish', () => {
        if (stream) return;
        const ms = performance.now() - measurement.start;
        const route = routeOf(path);
        timings.record({ listener, method: req.method ?? 'GET', route, status: res.statusCode, ms, spans: measurement.spans });
        if (ms >= SLOW_REQUEST_MS) log.metric('slow_request', { listener, method: req.method, route, status: res.statusCode, durationMs: Math.round(ms), spans: spansOf(measurement) });
      });
      await handle(req, res);
    });
  };
}
