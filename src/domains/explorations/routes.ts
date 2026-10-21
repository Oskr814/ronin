import { Hono } from 'hono';
import { log } from '../../platform/logger.js';
import { HISTORY_DAYS } from '../runs/data.js';
import { isExplorationPr } from './review.js';
import { corridasOf, exploracionList, exploracionRows, exploreNow, inventarioOf, liveRuns, parseExploreNow, prsOf } from './board.js';
import { repoGithub } from '../items/github.js';
import { refusal, visibleRepos, visibleRuns } from '../access/visible.js';
import type { Access } from '../access/access.js';
import { anyObject, jsonBody, onError, onlyJson } from '../../platform/http/middleware.js';
import type { DashboardEnv } from '../access/http.js';

// Exploraciones (#155) from the dashboard, in Hono (#235, stage 6) —
// apps/api/routes.ts mounts them under /api/exploraciones:
//   GET  /                                 each app a repo explores, with its exploration PR's findings counted and its runs (explorations/board.ts)
//   GET  /<owner>/<repo>/<app>/corridas    the app's exploration runs, with their agents
//   GET  /<owner>/<repo>/<app>/inventario  the app's functions and their coverage (inventory.yml)
//   POST /<owner>/<repo>/<app>/run         explore it now: { maxFunctions, hours, tonight } (Explorar ahora), as whoever is logged in

const MISSING = { error: 'ningún repo de ronin explora esa app' };

// The repo, if the session sees it and it explores the app.
async function exploring(access: Access, owner: string, name: string, app: string) {
  const entry = (await visibleRepos(access)).find((e) => e.productRepo === `${owner}/${name}`);
  return entry && (entry.explore ?? []).includes(app) ? entry : undefined;
}

export function explorationRoutes() {
  return new Hono<DashboardEnv>()
    .onError(onError)
    .get('/', async (c) => {
      const entries = await visibleRepos(c.env.access);
      const runs = await visibleRuns(c.env.access, HISTORY_DAYS);
      const github = await Promise.all(entries.map((entry) => repoGithub(entry)));
      const prs = prsOf(entries, github);
      return c.json({ apps: await exploracionList(entries, exploracionRows(entries, prs, runs, await liveRuns(entries)), runs, prs) }, 200);
    })
    .get('/:owner/:name/:app/corridas', async (c) => {
      const entry = await exploring(c.env.access, c.req.param('owner'), c.req.param('name'), c.req.param('app'));
      if (!entry) return c.json(MISSING, 404);
      return c.json({ corridas: await corridasOf(entry, c.req.param('app'), await visibleRuns(c.env.access, HISTORY_DAYS)) }, 200);
    })
    .get('/:owner/:name/:app/inventario', async (c) => {
      const entry = await exploring(c.env.access, c.req.param('owner'), c.req.param('name'), c.req.param('app'));
      if (!entry) return c.json(MISSING, 404);
      const pr = (await repoGithub(entry))?.prs.find(isExplorationPr);
      return c.json(await inventarioOf(entry, c.req.param('app'), pr), 200);
    })
    // Anyone who sees the repo can, as with a new issue, with the permission for actions (#174).
    .post('/:owner/:name/:app/run', onlyJson,
      jsonBody(64 * 1024, 'el pedido no llegó bien'), anyObject(), async (c) => {
        const app = c.req.param('app');
        const entry = await exploring(c.env.access, c.req.param('owner'), c.req.param('name'), app);
        if (!entry) return c.json(MISSING, 404);
        const refused = refusal(c, c.env.access, entry.productRepo, 'acciones');
        if (refused) return refused;
        const launched = await exploreNow(entry, app, c.env.session.login, parseExploreNow(c.req.valid('json')));
        log.info(`tablero: ${c.env.session.login} lanzó una exploración de ${app} en ${entry.productRepo}`);
        return c.json(launched, 200);
      });
}
