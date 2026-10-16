// Long-running companion to the cron-driven tick() (see index.ts): listens
// for GitHub webhook deliveries and, for the event/action combos that
// actually matter (see events.ts's scopeForEvent), starts an event handler
// right away — its own process (handler.ts) that runs only the flows that
// event can move, for only the issue or PR it's about. The cron tick stays as
// the reconciliation pass. See docs/DESIGN.md §14.
//
// Deliberately its own process (installed via
// scripts/setup-webhook-service.sh as a systemd --user service), not folded
// into index.ts: it needs to stay up permanently, while index.ts's tick() is
// a one-shot invoked by cron every N minutes.
import { createServer, type IncomingMessage } from 'node:http';
import { config } from '../core/config.js';
import { loadRepos } from '../core/repos.js';
import { launchWorker } from '../core/worker-launch.js';
import { verifySignature, scopeForEvent, type EventPayload } from './events.js';
import { log } from '../core/logger.js';
import type { Scope } from '../tick.js';
import type { EventHandlerRequest } from './handler.js';

if (!config.webhookSecret) {
  throw new Error('WEBHOOK_SECRET no está seteado — ver .env.example. webhook-server no puede arrancar sin validar firmas.');
}

// Open debounce windows, one per repo + resources: what's been asked of them
// so far, and the timer that starts their handler.
const pending = new Map<string, { repo: string; scope: Scope; receivedAt: number; timer: NodeJS.Timeout }>();

// Coalesces a burst of deliveries about the same thing (a review's several
// inline comments, a few check suites finishing together) into one handler,
// with every flow any of them asked for. Different PRs or issues get their
// own handlers, at once.
function scheduleHandler(repo: string, scope: Scope): void {
  const key = JSON.stringify([repo, [...scope.resources].sort()]);
  const open = pending.get(key);
  if (open) {
    open.scope = { ...open.scope, flows: [...new Set([...open.scope.flows, ...scope.flows])] };
    return;
  }
  const entry = {
    repo,
    scope,
    receivedAt: Date.now(),
    timer: setTimeout(() => {
      pending.delete(key);
      log.info(`webhook: atendiendo ${entry.scope.resources.join(', ')} en ${repo} (${entry.scope.flows.join(', ')})`);
      try {
        const request: EventHandlerRequest = { repo, scope: entry.scope, receivedAt: entry.receivedAt };
        launchWorker('webhooks/handler', request);
      } catch (error) {
        // The cron tick picks the event up anyway, just later.
        log.error('webhook: no se pudo lanzar el handler', error);
      }
    }, config.webhookDebounceMs),
  };
  pending.set(key, entry);
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
  let payload: EventPayload;
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
      const target = typeof eventName === 'string' ? scopeForEvent(eventName, payload, trackedRepos) : null;
      if (target) scheduleHandler(target.repo, target.scope);
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
