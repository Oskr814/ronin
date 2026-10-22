import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../logger.js';
import { ActionRefused, describeActions, validateAction, type ActionInput, type CheckoutState, type RunScope, type ValidAction } from './catalog.js';
import type { ActionResult } from './executors.js';
import { connectionFromRun } from './peer.js';

// The supervisor's side of the actions (#257): a small HTTP server on
// loopback, one per run, that holds whatever the actions need (the GitHub
// write token) while the agent only gets its URL and a credential good for
// this run and this scope. The agent's client (bin/ronin-act) carries no
// secret of its own. The credential alone is not enough: once the run's
// `claude` is up (bind), only its own processes are answered (peer.ts).

export interface ActionCall {
  at: string;
  name: string;
  outcome: 'ok' | 'refused' | 'error';
  error?: string;
}

export interface ActionsServer {
  url: string;
  token: string;
  // Every call, refused ones included, for the run's log.
  calls: ActionCall[];
  // What result.report said, when the agent got to it.
  report: () => ActionInput<'result.report'> | null;
  // The run's `claude`: from here on, only it and its descendants are
  // answered. Before it, nobody is.
  bind: (pid: number) => void;
  close: () => Promise<void>;
}

export interface ActionsServerOptions {
  scope: RunScope;
  checkout: () => Promise<CheckoutState>;
  execute: (action: ValidAction) => Promise<ActionResult>;
  label: string;
  // Whether a connection comes from the run: peer.ts's, replaceable in tests.
  fromRun?: (clientPort: number, serverPort: number, root: number) => boolean;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256 * 1024) throw new ActionRefused('la entrada es demasiado grande');
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ActionRefused('la entrada no es JSON');
  }
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startActionsServer(opts: ActionsServerOptions): Promise<ActionsServer> {
  const token = randomBytes(24).toString('hex');
  const calls: ActionCall[] = [];
  let report: ActionInput<'result.report'> | null = null;
  let root: number | null = null;
  const fromRun = opts.fromRun ?? connectionFromRun;
  // One action at a time, in the order they arrive: two pushes, or a reply
  // racing the push it talks about, would otherwise interleave.
  let queue: Promise<unknown> = Promise.resolve();

  const handle = async (name: string, raw: unknown): Promise<{ status: number; payload: unknown }> => {
    const call: ActionCall = { at: new Date().toISOString(), name, outcome: 'ok' };
    calls.push(call);
    try {
      const action = await validateAction(opts.scope, name, raw, opts.checkout);
      const result = await opts.execute(action);
      if (action.name === 'result.report') report = action.input;
      log.info(`[${opts.label}] acción ${name}: ok`);
      return { status: 200, payload: { ok: true, ...result } };
    } catch (error) {
      const refused = error instanceof ActionRefused;
      call.outcome = refused ? 'refused' : 'error';
      call.error = (error as Error).message;
      if (refused) log.info(`[${opts.label}] acción ${name} rechazada: ${call.error}`);
      else log.error(`[${opts.label}] acción ${name} falló`, error);
      return refused
        ? { status: 400, payload: { error: call.error } }
        : { status: 500, payload: { error: 'la acción falló del lado de ronin; no la repitas más de una vez' } };
    }
  };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (!sameToken((req.headers.authorization ?? '').replace(/^Bearer /, ''), token)) return send(401, { error: 'credencial inválida' });
    const { localPort, remotePort } = req.socket;
    if (root === null || !remotePort || !localPort || !fromRun(remotePort, localPort, root)) {
      log.error(`[${opts.label}] acciones: una llamada que no viene de la corrida, rechazada`);
      return send(403, { error: 'esta llamada no viene de la corrida' });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/actions') return send(200, { actions: describeActions(opts.scope) });

    const match = /^\/actions\/([\w.-]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) return send(404, { error: 'no existe' });
    let raw: unknown;
    try {
      raw = await readJson(req);
    } catch (error) {
      return send(400, { error: (error as Error).message });
    }
    const done = queue.then(() => handle(match[1], raw));
    queue = done.catch(() => {});
    const { status, payload } = await done;
    send(status, payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    report: () => report,
    bind: (pid) => { root = pid; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
