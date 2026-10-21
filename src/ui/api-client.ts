import type { ClientResponse } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';

// What the tablero's and the portal's pages share to talk to their API,
// typed with Hono's client (hc) from the server's routes: a change on the
// server that a page doesn't follow breaks the build, not the page.

// An answer that didn't go well: what the server said, its status, and the
// rest of its body (a deploy's new plan).
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

// The fetch under hc. A change goes as JSON, the only way the server takes
// one: with nothing to say (cancel, skip, log out) its body is {}. As
// Headers: the client's may come as one, which spread into an object would
// lose its Content-Type.
export const jsonFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const change = init?.method && init.method !== 'GET';
  if (change && !init?.body) headers.set('Content-Type', 'application/json');
  return fetch(input, { ...init, headers, ...(change && !init?.body ? { body: '{}' } : {}) });
};

// The body of the answer when it went well, or an ApiError.
type Success<R> = R extends ClientResponse<infer T, infer S, infer _F> ? (S extends SuccessStatusCode ? T : never) : never;
export async function ok<R extends ClientResponse<unknown, number, string>>(pending: Promise<R>): Promise<Success<R>> {
  const response = await pending;
  if (!response.ok) {
    const body = await (response.json() as Promise<Record<string, unknown>>).catch(() => null);
    throw new ApiError(typeof body?.error === 'string' ? body.error : 'Algo falló. Prueba de nuevo.', response.status, body);
  }
  return (response.status === 204 ? null : await response.json()) as Success<R>;
}
