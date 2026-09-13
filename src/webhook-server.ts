// Long-running companion to the cron-driven tick() (see index.ts): listens
// for GitHub webhook deliveries and, for the handful of event/action combos
// that actually matter (assignment, external PR review, mention/command
// comments — see webhook-events.ts), triggers a tick sooner than the next
// cron slot instead of reimplementing any of tick()'s own discovery logic.
//
// Deliberately its own process (installed via
// scripts/setup-webhook-service.sh as a systemd --user service), not folded
// into index.ts: it needs to stay up permanently, while index.ts's tick() is
// a one-shot invoked by cron every N minutes.
import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config } from './config.js';
import { loadRepos } from './repos.js';
import { verifySignature, shouldTriggerTick } from './webhook-events.js';
import { log } from './logger.js';

if (!config.webhookSecret) {
  throw new Error('WEBHOOK_SECRET no está seteado — ver .env.example. webhook-server no puede arrancar sin validar firmas.');
}

const REPO_DIR = join(import.meta.dirname, '..');
const RUN_TICK_SCRIPT = join(REPO_DIR, 'scripts', 'run-tick.sh');

// Set only while a debounce window is open — see scheduleTick.
let pendingTimer: NodeJS.Timeout | null = null;

// Coalesces a burst of qualifying webhook deliveries (e.g. several PR
// comments landing seconds apart) into a single tick trigger, so the AI
// pipeline isn't asked to spin up a run per event. The tick itself is also
// still single-flight via run-tick.sh's own flock on .tick.lock — if a
// cron-triggered tick is already in progress when this fires, run-tick.sh
// just skips and logs it, exactly as it does for an overlapping cron tick.
function scheduleTick(): void {
  if (pendingTimer) return; // a trigger is already queued for this burst
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    log.info('webhook: disparando tick anticipado');
    const child = spawn(RUN_TICK_SCRIPT, [], { stdio: 'ignore', detached: true });
    child.on('error', (error) => log.error('webhook: no se pudo lanzar run-tick.sh', error));
    child.unref();
  }, config.webhookDebounceMs);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    log.error('webhook: fallo leyendo el body', error);
    res.writeHead(400).end();
    return;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, config.webhookSecret)) {
    log.info('webhook: firma inválida, rechazado');
    res.writeHead(401).end();
    return;
  }

  const eventName = req.headers['x-github-event'];
  let payload: { action?: string; repository?: { full_name?: string } };
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.writeHead(400).end();
    return;
  }

  // ping is GitHub's own delivery test when the webhook is created — always
  // a 200, never worth logging as noise.
  if (eventName !== 'ping') {
    try {
      const repos = await loadRepos();
      const trackedRepos = repos.map((r) => r.productRepo);
      if (typeof eventName === 'string' && shouldTriggerTick(eventName, payload, trackedRepos)) {
        scheduleTick();
      }
    } catch (error) {
      // A malformed repos.json or a transient read failure must never make
      // GitHub retry-storm this endpoint — log and still 200 below.
      log.error('webhook: fallo evaluando el evento', error);
    }
  }

  res.writeHead(202).end();
});

server.listen(config.webhookPort, () => {
  log.info(`webhook-server escuchando en :${config.webhookPort}`);
});
