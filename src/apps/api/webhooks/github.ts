// GitHub's webhook deliveries (POST /api/webhooks/github): for the
// event/action combos that actually matter (see events.ts's scopeForEvent),
// starts an event handler right away — its own process (handler.ts) that
// runs only the flows that event can move, for only the issue or PR it's
// about. The cron tick stays as the reconciliation pass. See
// docs/DESIGN.md §14. Served by the ronin server (src/apps/api/main.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '@platform/config/config.js';
import { loadRepos } from '@platform/config/repos.js';
import { launchWorker } from '@platform/workers/worker-launch.js';
import { getDb } from '@platform/db/db.js';
import { enqueueEvent } from '../jobs/store.js';
import { EventDebouncer } from './debounce.js';
import { verifySignature, scopeForEvent, ackTarget, comesInBursts, type EventPayload } from './events.js';
import { addAckReaction } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import type { EventHandlerRequest } from './handler.js';

// The debounce windows (debounce.ts): each one, once it closes, a handler.
const debouncer = new EventDebouncer((repo, scope, receivedAt) => {
  log.info(`webhook: atendiendo ${scope.resources.join(', ')} en ${repo} (${scope.flows.join(', ')})`);
  startHandler({ repo, scope, receivedAt }).catch((error) => {
    // The tick picks the event up anyway, just later.
    log.error('webhook: no se pudo lanzar el handler', error);
  });
});

// With DATABASE_URL (#235, stage 3), a job in the queue that the runner
// starts (apps/api/jobs/runner.ts): one already queued for the same issues
// or PRs takes this one's flows instead of a second run being queued
// (enqueueEvent, #370). Without it, its process right away, as before.
async function startHandler(request: EventHandlerRequest): Promise<void> {
  const db = getDb();
  if (!db) {
    launchWorker('apps/api/webhooks/handler', request);
    return;
  }
  const dedupeKey = `event:${JSON.stringify([request.repo, [...request.scope.resources].sort()])}`;
  const { joined } = await enqueueEvent(db, { repo: request.repo, payload: request, dedupeKey });
  if (joined) log.info(`webhook: ya había uno en cola para ${request.scope.resources.join(', ')}; se le suman ${request.scope.flows.join(', ')}`);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleGithubWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const target = typeof eventName === 'string' ? scopeForEvent(eventName, payload, trackedRepos, config.githubLogin) : null;
      if (target) {
        debouncer.schedule(target.repo, target.scope, comesInBursts(eventName as string) ? config.webhookBurstDebounceMs : config.webhookDebounceMs);
        // The "got it" on a mention, right away — not awaited: GitHub's
        // delivery doesn't wait on it, and a failure costs only the 👀.
        const ack = ackTarget(eventName as string, payload, config.githubLogin);
        if (ack) {
          addAckReaction(target.repo, ack.commentId, ack.kind)
            .catch((error) => log.info(`webhook: no se pudo poner el 👀 en el comentario ${ack.commentId}: ${(error as Error).message}`));
        }
      }
    } catch (error) {
      // A malformed repos.json or a transient read failure must never make
      // GitHub retry-storm this endpoint — log and still 200 below.
      log.error('webhook: fallo evaluando el evento', error);
    }
  }

  res.writeHead(202).end();
}
