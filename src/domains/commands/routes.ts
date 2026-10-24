import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eventHub, type LiveEvent } from '@platform/events/bus.js';
import { sees } from '../access/access.js';
import type { DashboardEnv } from '../access/http.js';

// The tablero's stream of what changed (#446) — apps/api/routes.ts mounts it:
//   GET /api/events   every change the session can see, as it happens (SSE)
// Each event names what changed (a command on acme/web#12); the page reads
// it again. `reconnected` after the server lost Postgres for a moment: read
// everything again. Without a database, 404: the pages keep polling.

const HEARTBEAT_MS = 15_000;

export function eventsRoutes(hub: () => ReturnType<typeof eventHub> = eventHub) {
  return new Hono<DashboardEnv>()
    .get('/', (c) => {
      const live = hub();
      if (!live) return c.json({ error: 'sin eventos en vivo' }, 404);
      const access = c.env.access;
      c.header('Cache-Control', 'no-store');
      return streamSSE(c, async (stream) => {
        const queue: LiveEvent[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = live.subscribe((event) => {
          if (event.repo !== undefined && !sees(access, event.repo)) return;
          queue.push(event);
          wake?.();
        });
        let open = true;
        stream.onAbort(() => {
          open = false;
          wake?.();
        });
        try {
          await stream.writeSSE({ event: 'ready', data: '{}' });
          while (open) {
            const event = queue.shift();
            if (event) {
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              continue;
            }
            // Until something comes, or a comment so no proxy takes it for dead.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, HEARTBEAT_MS);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = null;
            if (open && !queue.length) await stream.write(': sigue\n\n');
          }
        } finally {
          unsubscribe();
        }
      });
    });
}
