import { hc, type InferResponseType } from 'hono/client';
import { ApiError, jsonFetch } from '../../../ui/api-client.js';
import type { PortalApi } from '../../../domains/portal/routes.js';

// The portal's API (/api/portal/*), typed from its routes (domains/portal/routes.ts):
// a change on the server that the page doesn't follow breaks the build, not
// the page.

export { ApiError, ok } from '../../../ui/api-client.js';

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

// Every answer carries the page's fingerprint.
const checkedFetch: typeof fetch = async (input, init) => {
  const response = await jsonFetch(input, init);
  checkVersion(response);
  return response;
};

export const client = hc<PortalApi>('/api/portal', { fetch: checkedFetch });

export type Me = InferResponseType<typeof client.me.$get, 200>;
export type Summary = InferResponseType<typeof client.requests.$get, 200>[number];
export type Detail = InferResponseType<(typeof client.requests)[':n']['$get'], 200>;
export type Message = Detail['messages'][number];
export type Question = NonNullable<Message['questions']>[number];
export type Understood = NonNullable<Message['understood']>;
export type App = Me['apps'][number];
