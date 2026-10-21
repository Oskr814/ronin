import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadRepos } from '../../platform/config/repos.js';
import { subscriptionView } from './subscription-view.js';
import { visibleRepos } from '../access/visible.js';
import type { DashboardEnv } from '../access/http.js';
import { adminsOnly } from '../../platform/http/middleware.js';
import { metricsView, parsePeriod } from './index.js';

// Métricas (#222, #234) from the dashboard, in Hono (#235, stage 6) —
// apps/api/routes.ts mounts them under /api/metrics. Admins only:
//   GET /?days=7|30|90&repo=<owner>/<repo>   how work moves in the repos: what comes in and out, how long it takes, who carries it
//   GET /subscription?account=<account>      how much of each Claude account's plan gets used, and ronin's share (metrics/subscription-view.ts)

// What's wrong with the query, as a 400 with the schema's words.
const query = <T extends z.ZodType>(schema: T) => zValidator('query', schema, (result, c) => {
  if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? 'consulta inválida' }, 400);
});

export function metricsRoutes() {
  return new Hono<DashboardEnv>()
    .use('*', adminsOnly('solo los administradores ven las métricas'))
    .get('/', query(z.object({
      // 30 when it doesn't say.
      days: z.string().optional().transform((v) => parsePeriod(v ?? null)).refine((days) => days !== null, 'days debe ser 7, 30 o 90'),
      repo: z.string().optional(),
    })), async (c) => {
      const { days, repo } = c.req.valid('query');
      const repos = (await visibleRepos(c.env.access)).map((entry) => entry.productRepo);
      if (repo && !repos.includes(repo)) return c.json({ error: `no hay un repo ${repo}` }, 404);
      return c.json(await metricsView(repos, days!, repo || null), 200);
    })
    .get('/subscription', query(z.object({ account: z.string().optional() })), async (c) => {
      const account = c.req.valid('query').account || null;
      const view = await subscriptionView(await loadRepos(), account);
      if (!view) return c.json({ error: `no hay una cuenta de Claude ${account}` }, 404);
      return c.json(view, 200);
    });
}
