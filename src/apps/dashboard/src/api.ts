import { hc, type ClientResponse, type InferResponseType } from 'hono/client';
import type { SuccessStatusCode } from 'hono/utils/http-status';
import type { DashboardApi } from '../../api/routes.js';

// The dashboard's API, typed from its routes (apps/api/routes.ts): a
// change on the server that a page doesn't follow breaks the build, not the
// page.

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

// A change goes as JSON, as the server takes no other (domains/items/routes.ts).
const jsonFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  return fetch(input, { ...init, headers });
};

export const client = hc<DashboardApi>('/', { fetch: jsonFetch });

// The body of the answer when it went well, or an ApiError with what the
// server said, and the rest of its answer (a deploy's new plan).
type Success<R> = R extends ClientResponse<infer T, infer S, infer _F> ? (S extends SuccessStatusCode ? T : never) : never;
export async function ok<R extends ClientResponse<unknown, number, string>>(pending: Promise<R>): Promise<Success<R>> {
  const response = await pending;
  if (!response.ok) {
    const body = await (response.json() as Promise<Record<string, unknown>>).catch(() => null);
    throw new ApiError(typeof body?.error === 'string' ? body.error : `${response.status}`, response.status, body);
  }
  return (await response.json()) as Success<R>;
}

export type DeployRepos = InferResponseType<typeof client.api.deploys.$get, 200>['repos'];
