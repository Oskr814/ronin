// The ronin server: a long-running companion to the cron-driven tick()
// (src/apps/api/tick/main.ts), installed as a systemd --user service
// (scripts/setup-server-service.sh) because it has to stay up, while tick()
// is a one-shot cron runs every N minutes.
//
// Its API lives under /api (api/), GitHub's webhooks included. Two
// listeners: the public one, the one the domain's proxy reaches, serves only
// the webhooks and, once configured, the request portal (public.ts,
// portal.ts); the tailnet one serves the dashboard — the web app and the
// whole API, behind a GitHub login (tailnet.ts). The second one only starts
// once the dashboard is configured.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../../core/config.js';
import { log } from '../../core/logger.js';
import { missingAuthConfig } from '../../server/api/auth.js';
import { createPortalHandler, missingPortalConfig } from './http/portal.js';
import { createPublicHandler } from './http/public.js';
import { createTailnetHandler } from './http/tailnet.js';
import { loadTeam } from '../../server/api/team.js';
import { warmDashboard } from '../../items/service.js';
import { timedRequests } from './http/timing.js';
import { getDb } from '../../db/db.js';
import { migrateToLatest } from '../../db/migrate.js';
import { startRunner } from './jobs/runner.js';
import { startScheduler } from './jobs/scheduler.js';

if (!config.webhookSecret) {
  throw new Error('WEBHOOK_SECRET no está seteado — ver .env.example. El servidor no puede arrancar sin validar las firmas de GitHub.');
}

// With DATABASE_URL (#235, stage 2), the database is brought up to date
// before anything is served. A migration that fails is logged and the
// server comes up anyway: what reads the database falls back as when it
// doesn't answer (settings-store.ts), and the dashboard stays reachable.
const db = getDb();
if (db) {
  try {
    const ran = await migrateToLatest(db);
    log.info(ran.length ? `base de datos: migraciones aplicadas: ${ran.join(', ')}` : 'base de datos: al día');
  } catch (error) {
    log.error('base de datos: no se pudo migrar', error);
  }
  // The job queue (#235, stage 3): the scheduler queues the tick at its
  // times, and the local runner starts every job — the tick and the
  // webhooks' handlers — in its own process. Cron isn't needed anymore.
  startScheduler(db);
  startRunner(db);
}

// A request that throws answers 500 and is logged: it never takes the
// process down with it.
function serve(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error(`servidor: falló ${req.method} ${req.url}`, error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

// The request portal (#114) shares the public listener, only once configured.
const missingPortal = missingPortalConfig(config.portal);
if (missingPortal.length > 0) log.info(`portal de pedidos desactivado: falta ${missingPortal.join(', ')} en .env`);
const portal = missingPortal.length === 0 ? createPortalHandler(config.portal) : undefined;

serve(timedRequests('público', createPublicHandler(undefined, portal))).listen(config.serverPort, () => {
  log.info(`ronin-server escuchando en :${config.serverPort} (público: los webhooks de GitHub${portal ? ` y el portal de pedidos, ${config.portal.url}` : ''})`);
});

const missing = missingAuthConfig(config.dashboard);
if (missing.length > 0) {
  log.info(`tablero desactivado: falta ${missing.join(', ')} en .env`);
} else {
  // The team's admins and who gets in (#174) on top of .env's, before the first request.
  await loadTeam();
  // 127.0.0.1 only: what reaches it is `tailscale serve`, never the LAN.
  serve(timedRequests('tablero', createTailnetHandler(config.dashboard))).listen(config.dashboard.tailnetPort, '127.0.0.1', () => {
    log.info(`tablero escuchando en 127.0.0.1:${config.dashboard.tailnetPort}, publicado en la tailnet como ${config.dashboard.url} (administradores: ${config.dashboard.admins.join(', ') || 'ninguno'})`);
  });
  // Read before anyone asks (see warmDashboard).
  warmDashboard().catch((error) => log.error('tablero: no se pudo leer GitHub al arrancar', error));
}
