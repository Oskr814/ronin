// GitHub's webhook deliveries (POST /api/webhooks/github): for the
// event/action combos that actually matter (see events.ts's scopeForEvent),
// starts an event handler right away — its own process (handler.ts) that
// runs only the flows that event can move, for only the issue or PR it's
// about. The cron tick stays as the reconciliation pass. See
// docs/DESIGN.md §14. Served by the ronin server (src/apps/api/main.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../../../core/config.js';
import { loadRepos } from '../../../core/repos.js';
import { launchWorker } from '../../../core/worker-launch.js';
import { getDb } from '../../../db/db.js';
import { enqueue } from '../jobs/store.js';
import { verifySignature, scopeForEvent, ackTarget, type EventPayload } from './events.js';
import { addAckReaction } from '../../../core/github.js';
import { log } from '../../../core/logger.js';
import type { Scope } from '../tick/tick.js';
import type { EventHandlerRequest } from './handler.js';

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
      const request: EventHandlerRequest = { repo, scope: entry.scope, receivedAt: entry.receivedAt };
      startHandler(request).catch((error) => {
        // The tick picks the event up anyway, just later.
        log.error('webhook: no se pudo lanzar el handler', error);
      });
    }, config.webhookDebounceMs),
  };
  pending.set(key, entry);
}

// With DATABASE_URL (#235, stage 3), a job in the queue that the runner
// starts (apps/api/jobs/runner.ts): one already queued for the same thing isn't
// queued twice. Without it, its process right away, as before.
async function startHandler(request: EventHandlerRequest): Promise<void> {
  const db = getDb();
  if (!db) {
    launchWorker('apps/api/webhooks/handler', request);
    return;
  }
  const dedupeKey = `event:${JSON.stringify([request.repo, [...request.scope.flows].sort(), [...request.scope.resources].sort()])}`;
  const id = await enqueue(db, 'event', { repo: request.repo, payload: request, dedupeKey });
  if (!id) log.info(`webhook: ya hay uno en cola para ${request.scope.resources.join(', ')}, este no hace falta`);
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
        scheduleHandler(target.repo, target.scope);
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
