import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadRepos } from '../../core/repos.js';
import { suscripcionView } from './subscription-view.js';
import { visibleRepos } from '../access/visible.js';
import type { DashboardEnv } from '../../apps/api/http/hono.js';
import { metricsView, parsePeriod } from './index.js';

// Métricas (#222, #234) from the dashboard, in Hono (#235, stage 6) —
// apps/api/routes.ts mounts them under /api/metricas. Admins only:
//   GET /?dias=7|30|90&repo=<owner>/<repo>   how work moves in the repos: what comes in and out, how long it takes, who carries it
//   GET /suscripcion?cuenta=<cuenta>         how much of each Claude account's plan gets used, and ronin's share (metrics/subscription-view.ts)

// What's wrong with the query, as a 400 with the schema's words.
const query = <T extends z.ZodType>(schema: T) => zValidator('query', schema, (result, c) => {
  if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? 'consulta inválida' }, 400);
});

export function metricsRoutes() {
  return new Hono<DashboardEnv>()
    .use('*', async (c, next) => {
      if (!c.env.access.admin) return c.json({ error: 'solo los administradores ven las métricas' }, 403);
      await next();
    })
    .get('/', query(z.object({
      // 30 when it doesn't say.
      dias: z.string().optional().transform((v) => parsePeriod(v ?? null)).refine((days) => days !== null, 'dias debe ser 7, 30 o 90'),
      repo: z.string().optional(),
    })), async (c) => {
      const { dias, repo } = c.req.valid('query');
      const repos = (await visibleRepos(c.env.access)).map((entry) => entry.productRepo);
      if (repo && !repos.includes(repo)) return c.json({ error: `no hay un repo ${repo}` }, 404);
      return c.json(await metricsView(repos, dias!, repo || null), 200);
    })
    .get('/suscripcion', query(z.object({ cuenta: z.string().optional() })), async (c) => {
      const account = c.req.valid('query').cuenta || null;
      const view = await suscripcionView(await loadRepos(), account);
      if (!view) return c.json({ error: `no hay una cuenta de Claude ${account}` }, 404);
      return c.json(view, 200);
    });
}
