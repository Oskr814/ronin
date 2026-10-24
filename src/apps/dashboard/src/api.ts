import { hc, type InferResponseType } from 'hono/client';
import { jsonFetch } from '@ui/api-client.js';
import type { DashboardApi } from '@apps/api/routes.js';

// The dashboard's API, typed from its routes (apps/api/routes.ts): a
// change on the server that a page doesn't follow breaks the build, not the
// page.

export { ApiError, ok } from '@ui/api-client.js';

export const client = hc<DashboardApi>('/', { fetch: jsonFetch });

export type DeployRepos = InferResponseType<typeof client.api.deploys.$get, 200>['repos'];
export type Metrics = InferResponseType<typeof client.api.metrics.$get, 200>;
export type RequestMetrics = InferResponseType<typeof client.api.metrics.requests.$get, 200>;
export type SubscriptionAccount = InferResponseType<typeof client.api.metrics.subscription.$get, 200>['cuentas'][number];
export type RequestRow = InferResponseType<typeof client.api.requests.$get, 200>['requests'][number];
export type RequestDetail = InferResponseType<(typeof client.api.requests)[':n']['$get'], 200>;
export type Run = InferResponseType<(typeof client.api.runs)[':runId']['$get'], 200>;
export type MeetingRow = InferResponseType<typeof client.api.meetings.$get, 200>['meetings'][number];
export type MeetingDetail = InferResponseType<(typeof client.api.meetings)[':n']['$get'], 200>;
export type Snapshot = InferResponseType<typeof client.api.snapshot.$get, 200>;
export type Today = InferResponseType<typeof client.api.today.$get, 200>;
export type ItemDetail = InferResponseType<(typeof client.api.items)[':id']['detail']['$get'], 200>;
export type Exploration = InferResponseType<(typeof client.api.items)[':id']['exploration']['$get'], 200>;
export type ItemRun = InferResponseType<(typeof client.api.items)[':id']['$get'], 200>['runs'][number];
// The run an item's page shows, as the shell reads it (shell/state.ts): its
// lines without its start and end, and more as they come while it goes.
export type ShownRun = { runId: string; summary: Run['summary']; lines: Run['lines'] };
