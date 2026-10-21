import { Hono } from 'hono';
import { pedidosRoutes, portalAdminRoutes } from '../portal/routes-dashboard.js';
import type { DashboardEnv } from './hono.js';

// The dashboard's API in Hono (#235, stage 6), a group of routes at a time:
// handleDashboard (api/dashboard.ts) hands it the paths of the groups that
// already moved, after tailnet.ts checked the session and its access; the
// rest still answer there. Each group lives with its domain.
export const dashboardApp = new Hono<DashboardEnv>()
  .notFound((c) => c.json({ error: 'no existe' }, 404))
  .route('/api/pedidos', pedidosRoutes())
  .route('/api/portal-admin', portalAdminRoutes());

export type DashboardApi = typeof dashboardApp;

// The paths it owns.
const GROUPS = ['/api/pedidos', '/api/portal-admin'];
export const ownsPath = (path: string) => GROUPS.some((group) => path === group || path.startsWith(`${group}/`));
