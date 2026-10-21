import { hc, type ClientResponse, type InferResponseType } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { PortalApi } from '../../../portal/routes.js';

// The portal's API (/api/portal/*), typed from its routes (portal/routes.ts):
// a change on the server that the page doesn't follow breaks the build, not
// the page.

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// A session that ended (a 401, except the login's own) goes back to the
// login: App sets where.
let unauthorized = () => {};
export function setUnauthorized(to: () => void): void {
  unauthorized = to;
}
export function ended(error: unknown): boolean {
  if (!(error instanceof ApiError && error.status === 401)) return false;
  unauthorized();
  return true;
}

// The server's fingerprint of this page's files, from the first answer: once
// it changes, a deploy happened and this page runs old code. It reloads
// itself, unless the person is in the middle of writing something (busy.ts).
let version: string | null = null;
let stale = false;
const staleListeners = new Set<() => void>();
export const isStale = () => stale;
export function onStale(listener: () => void): () => void {
  staleListeners.add(listener);
  return () => staleListeners.delete(listener);
}

let idle: () => boolean = () => true;
export function setIdleCheck(check: () => boolean): void {
  idle = check;
}

function checkVersion(response: Response): void {
  const now = response.headers.get('X-Portal-Version');
  if (!now) return;
  if (version === null) version = now;
  else if (now !== version) {
    if (idle()) location.reload();
    else if (!stale) {
      stale = true;
      for (const listener of staleListeners) listener();
    }
  }
}

const checkedFetch: typeof fetch = async (input, init) => {
  // As Headers: the client's may come as one, which spread into an object
  // would lose its Content-Type (and the server refuses a POST without it).
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  // A change with nothing to say (cancel, skip, log out) still goes as JSON:
  // the server takes no change sent any other way (apps/api/http/portal.ts).
  const change = init?.method && init.method !== 'GET';
  if (change && !init?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(input, { ...init, headers, ...(change && !init?.body ? { body: '{}' } : {}) });
  checkVersion(response);
  return response;
};

export const client = hc<PortalApi>('/api/portal', { fetch: checkedFetch });

// The body of the answer when it went well, or an ApiError with what the
// server said.
type Success<R> = R extends ClientResponse<infer T, infer S, infer _F> ? (S extends SuccessStatusCode ? T : never) : never;
export async function ok<R extends ClientResponse<unknown, number, string>>(pending: Promise<R>): Promise<Success<R>> {
  const response = await pending;
  if (!response.ok) {
    const said = await (response.json() as Promise<{ error?: string }>).then((b) => b?.error).catch(() => null);
    throw new ApiError(said ?? 'Algo falló. Prueba de nuevo.', response.status);
  }
  return (response.status === 204 ? null : await response.json()) as Success<R>;
}

export type Me = InferResponseType<typeof client.me.$get, 200>;
export type Summary = InferResponseType<typeof client.requests.$get, 200>[number];
export type Detail = InferResponseType<(typeof client.requests)[':n']['$get'], 200>;
export type Message = Detail['messages'][number];
export type Question = NonNullable<Message['questions']>[number];
export type Understood = NonNullable<Message['understood']>;
export type App = Me['apps'][number];
