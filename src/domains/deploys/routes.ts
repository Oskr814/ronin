import { Hono } from 'hono';
import { z } from 'zod';
import { log } from '../../platform/logger.js';
import { DespliegueError, despliegues, parseRelease, planDespliegue, publishDespliegue } from './board.js';
import { can } from '../access/team.js';
import { refusal, visibleRepos } from '../access/visible.js';
import { body, jsonBody, onError, type DashboardEnv } from '../../apps/api/http/hono.js';

// Despliegues (#158) from the dashboard, in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them under /api/despliegues. Admins, and whoever
// an admin let deploy a repo (#174):
//   GET  /                         each repo with deploy in repos.json it can deploy: what's merged and not deployed, its last releases and their workflow
//   POST /<owner>/<repo>/plan      what a release would carry: { tag, prs: 'all' | [n…], prerelease? }, with its problems
//   POST /<owner>/<repo>/publish   publishes it: the same, and { title?, notes?, fingerprint? }

export function deployRoutes() {
  const release = body(z.record(z.string(), z.unknown()));
  const json = () => jsonBody(64 * 1024, 'el pedido no llegó bien');
  return new Hono<DashboardEnv>()
    .onError(onError([DespliegueError]))
    .get('/', async (c) => {
      const mine = (await visibleRepos(c.env.access)).filter((entry) => can(c.env.access, entry.productRepo, 'desplegar'));
      if (!mine.length) return c.json({ error: 'no tienes permiso para desplegar ningún repo' }, 403);
      return c.json({ repos: await despliegues(mine) }, 200);
    })
    .use('/:owner/:name/*', async (c, next) => {
      const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
      const refused = refusal(c, c.env.access, repo, 'desplegar');
      if (refused) return refused;
      if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return c.json({ error: 'se espera JSON' }, 415);
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repo && e.deploy);
      if (!entry) return c.json({ error: 'ese repo no se despliega desde ronin (deploy en repos.json)' }, 404);
      await next();
    })
    .post('/:owner/:name/plan', json(), release, async (c) => {
      const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repo)!;
      return c.json(await planDespliegue(entry, parseRelease(c.req.valid('json'))), 200);
    })
    .post('/:owner/:name/publish', json(), release, async (c) => {
      const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
      const entry = (await visibleRepos(c.env.access)).find((e) => e.productRepo === repo)!;
      const done = await publishDespliegue(entry, parseRelease(c.req.valid('json')), c.env.session.login);
      log.info(`tablero: ${c.env.session.login} publicó ${done.tag} en ${repo}`);
      return c.json(done, 200);
    });
}
