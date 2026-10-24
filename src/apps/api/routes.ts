import { Hono } from 'hono';
import { settingsRoutes } from '@domains/settings/routes.js';
import { deployRoutes } from '@domains/deploys/routes.js';
import { explorationRoutes } from '@domains/explorations/routes.js';
import { boardRoutes, itemsRoutes } from '@domains/items/routes.js';
import { meetingsRoutes } from '@domains/meetings/routes.js';
import { metricsRoutes } from '@domains/metrics/routes.js';
import { requestsRoutes, portalAdminRoutes } from '@domains/portal/routes-dashboard.js';
import { evidenceRoutes, runsRoutes } from '@domains/runs/routes.js';
import { eventsRoutes } from '@domains/commands/routes.js';
import type { DashboardEnv } from '@domains/access/http.js';
import { getDb } from '@platform/db/db.js';
import { enqueueEvent } from './jobs/store.js';

// What's asked from the tablero starts its issue's or PR's run now (#446):
// a job like a webhook's (webhooks/github.ts), joined to one already
// waiting for the same ones. Without a database, the next tick.
async function wake(repo: string, resources: string[]): Promise<void> {
  const db = getDb();
  if (!db) return;
  const payload = { repo, scope: { flows: ['issues'], resources }, receivedAt: Date.now() };
  await enqueueEvent(db, { repo, payload, dedupeKey: `event:${JSON.stringify([repo, [...resources].sort()])}` });
}

// The dashboard's API in Hono (#235, stage 6): handleDashboard (api/
// apps/api/http/dashboard.ts) hands it every /api path once tailnet.ts checked the session
// and its access. Each group of routes lives with its domain.
export const dashboardApp = new Hono<DashboardEnv>()
  .notFound((c) => c.json({ error: 'no existe' }, 404))
  .route('/api/requests', requestsRoutes())
  .route('/api/portal-admin', portalAdminRoutes())
  .route('/api/meetings', meetingsRoutes())
  .route('/api/deploys', deployRoutes())
  .route('/api/metrics', metricsRoutes())
  .route('/api/explorations', explorationRoutes())
  .route('/api/settings', settingsRoutes())
  .route('/api/runs', runsRoutes())
  .route('/api/events', eventsRoutes())
  .route('/api/evidence', evidenceRoutes())
  .route('/api/items', itemsRoutes({ wake }))
  .route('/api', boardRoutes());

export type DashboardApi = typeof dashboardApp;
