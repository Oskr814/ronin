import { Hono } from 'hono';
import { log } from '@platform/logger.js';
import { deploysView, parseRelease, planBoardRelease, publishBoardRelease } from './board.js';
import { can } from '../access/team.js';
import { refusal, visibleRepos } from '../access/visible.js';
import { anyObject, jsonBody, onError, onlyJson, repoParam } from '@platform/http/middleware.js';
import type { DashboardEnv } from '../access/http.js';

// Despliegues (#158) from the dashboard, in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them under /api/deploys. Admins, and whoever
// an admin let deploy a repo (#174):
//   GET  /                         each repo with deploy in repos.json it can deploy: what's merged and not deployed, its last releases and their workflow
//   POST /<owner>/<repo>/plan      what a release would carry: { tag, prs: 'all' | [n…], prerelease? }, with its problems
//   POST /<owner>/<repo>/publish   publishes it: the same, and { title?, notes?, fingerprint? }

export function deployRoutes() {
  const release = anyObject();
  const json = () => jsonBody(64 * 1024, 'el pedido no llegó bien');
  return new Hono<DashboardEnv>()
    .onError(onError)
    .get('/', async (c) => {
      const mine = (await visibleRepos(c.env.access)).filter((entry) => can(c.env.access, entry.productRepo, 'desplegar'));
      if (!mine.length) return c.json({ error: 'no tienes permiso para desplegar ningún repo' }, 403);
      return c.json({ repos: await deploysView(mine) }, 200);
    })
    .use('/:owner/:name/*', async (c, next) => refusal(c, c.env.access, repoParam(c), 'desplegar') ?? next(), onlyJson, async (c, next) => {
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repoParam(c) && e.deploy);
      if (!entry) return c.json({ error: 'ese repo no se despliega desde ronin (deploy en repos.json)' }, 404);
      await next();
    })
    .post('/:owner/:name/plan', json(), release, async (c) => {
      const repo = repoParam(c);
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repo)!;
      return c.json(await planBoardRelease(entry, parseRelease(c.req.valid('json'))), 200);
    })
    .post('/:owner/:name/publish', json(), release, async (c) => {
      const repo = repoParam(c);
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repo)!;
      const done = await publishBoardRelease(entry, parseRelease(c.req.valid('json')), c.env.session.login);
      log.info(`tablero: ${c.env.session.login} publicó ${done.tag} en ${repo}`);
      return c.json(done, 200);
    });
}
