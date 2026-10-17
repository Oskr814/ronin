// The ronin server: a long-running companion to the cron-driven tick()
// (src/index.ts), installed as a systemd --user service
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
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { missingAuthConfig } from './api/auth.js';
import { createPortalHandler, missingPortalConfig } from './portal.js';
import { createPublicHandler } from './public.js';
import { createTailnetHandler } from './tailnet.js';

if (!config.webhookSecret) {
  throw new Error('WEBHOOK_SECRET no está seteado — ver .env.example. El servidor no puede arrancar sin validar las firmas de GitHub.');
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

serve(createPublicHandler(undefined, portal)).listen(config.serverPort, () => {
  log.info(`ronin-server escuchando en :${config.serverPort} (público: los webhooks de GitHub${portal ? ` y el portal de pedidos, ${config.portal.url}` : ''})`);
});

const missing = missingAuthConfig(config.dashboard);
if (missing.length > 0) {
  log.info(`tablero desactivado: falta ${missing.join(', ')} en .env`);
} else {
  // 127.0.0.1 only: what reaches it is `tailscale serve`, never the LAN.
  serve(createTailnetHandler(config.dashboard)).listen(config.dashboard.tailnetPort, '127.0.0.1', () => {
    log.info(`tablero escuchando en 127.0.0.1:${config.dashboard.tailnetPort}, publicado en la tailnet como ${config.dashboard.url} (administradores: ${config.dashboard.admins.join(', ') || 'ninguno'})`);
  });
}
