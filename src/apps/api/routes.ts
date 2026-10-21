import { Hono } from 'hono';
import { ajustesRoutes } from '../../ajustes/routes.js';
import { deployRoutes } from '../../deploy/routes.js';
import { explorationRoutes } from '../../exploration/routes.js';
import { boardRoutes, itemsRoutes } from '../../items/routes.js';
import { meetingsRoutes } from '../../meetings/routes.js';
import { metricsRoutes } from '../../metrics/routes.js';
import { pedidosRoutes, portalAdminRoutes } from '../../portal/routes-dashboard.js';
import { evidenceRoutes, runsRoutes } from '../../runs/routes.js';
import type { DashboardEnv } from './http/hono.js';

// The dashboard's API in Hono (#235, stage 6): handleDashboard (api/
// dashboard.ts) hands it every /api path once tailnet.ts checked the session
// and its access. Each group of routes lives with its domain.
export const dashboardApp = new Hono<DashboardEnv>()
  .notFound((c) => c.json({ error: 'no existe' }, 404))
  .route('/api/pedidos', pedidosRoutes())
  .route('/api/portal-admin', portalAdminRoutes())
  .route('/api/reuniones', meetingsRoutes())
  .route('/api/despliegues', deployRoutes())
  .route('/api/metricas', metricsRoutes())
  .route('/api/exploraciones', explorationRoutes())
  .route('/api/ajustes', ajustesRoutes())
  .route('/api/runs', runsRoutes())
  .route('/api/evidence', evidenceRoutes())
  .route('/api/items', itemsRoutes())
  .route('/api', boardRoutes());

export type DashboardApi = typeof dashboardApp;
