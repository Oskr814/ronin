import { hc, type InferResponseType } from 'hono/client';
import { jsonFetch } from '../../../ui/api-client.js';
import type { DashboardApi } from '../../api/routes.js';

// The dashboard's API, typed from its routes (apps/api/routes.ts): a
// change on the server that a page doesn't follow breaks the build, not the
// page.

export { ApiError, ok } from '../../../ui/api-client.js';

export const client = hc<DashboardApi>('/', { fetch: jsonFetch });

export type DeployRepos = InferResponseType<typeof client.api.deploys.$get, 200>['repos'];
export type Metrics = InferResponseType<typeof client.api.metrics.$get, 200>;
export type SubscriptionAccount = InferResponseType<typeof client.api.metrics.subscription.$get, 200>['cuentas'][number];
export type RequestRow = InferResponseType<typeof client.api.requests.$get, 200>['requests'][number];
export type RequestDetail = InferResponseType<(typeof client.api.requests)[':n']['$get'], 200>;
export type Run = InferResponseType<(typeof client.api.runs)[':runId']['$get'], 200>;
