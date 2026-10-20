import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RouteTimings, timed } from '../core/timing.js';

const metric = vi.fn();
vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn(), metric: (...a: unknown[]) => metric(...a) } }));

process.env.SLOW_REQUEST_MS = '20';
const { timedRequests } = await import('./timing.js');

const timings = new RouteTimings();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === '/api/slow/7') {
    await timed('github', () => wait(5));
    await wait(30);
    res.end('lento');
  } else if (req.url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: x\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  }
}

let server: Server;
let base: string;
beforeAll(async () => {
  const handle = timedRequests('tablero', app, timings);
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('timing the API', () => {
  it('answers with Server-Timing, also when the handler only calls end(), and sums the route up', async () => {
    const fast = await fetch(`${base}/api/fast`);
    expect(fast.headers.get('server-timing')).toMatch(/^total;dur=[\d.]+$/);
    const slow = await fetch(`${base}/api/slow/7`);
    expect(await slow.text()).toBe('lento');
    expect(slow.headers.get('server-timing')).toMatch(/^total;dur=[\d.]+, github;dur=[\d.]+;desc="1"$/);
    await wait(10);
    const lines = timings.flush();
    expect(lines.map((l) => l.route).sort()).toEqual(['/api/fast', '/api/slow/:n']);
    expect(lines.find((l) => l.route === '/api/slow/:n')).toMatchObject({ count: 1, githubCount: 1 });
  });

  it('logs a slow request with its route and spans, never its path', async () => {
    metric.mockClear();
    await (await fetch(`${base}/api/slow/7`)).text();
    await wait(10);
    expect(metric).toHaveBeenCalledWith('slow_request', expect.objectContaining({ listener: 'tablero', method: 'GET', route: '/api/slow/:n', status: 200, spans: { github: expect.objectContaining({ count: 1 }) } }));
  });

  it('leaves the web app’s files and the live streams out', async () => {
    timings.flush();
    const page = await fetch(`${base}/`);
    expect(page.headers.get('server-timing')).toBeNull();
    await (await fetch(`${base}/api/stream`)).text();
    await wait(10);
    expect(timings.flush()).toEqual([]);
  });
});
