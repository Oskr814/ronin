// The ronin server: a long-running companion to the cron-driven tick()
// (src/index.ts), installed as a systemd --user service
// (scripts/setup-server-service.sh) because it has to stay up, while tick()
// is a one-shot cron runs every N minutes.
//
// Its API lives under /api (api/), GitHub's webhooks included. The public
// listener, the one the domain's proxy reaches, serves only the webhooks
// (public.ts).
import { createServer } from 'node:http';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { createPublicHandler } from './public.js';

if (!config.webhookSecret) {
  throw new Error('WEBHOOK_SECRET no está seteado — ver .env.example. El servidor no puede arrancar sin validar las firmas de GitHub.');
}

const handlePublic = createPublicHandler();

// A request that throws answers 500 and is logged: it never takes the
// process down with it.
const server = createServer((req, res) => {
  handlePublic(req, res).catch((error) => {
    log.error(`servidor: falló ${req.method} ${req.url}`, error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(config.serverPort, () => {
  log.info(`ronin-server escuchando en :${config.serverPort} (público: solo los webhooks de GitHub)`);
});
