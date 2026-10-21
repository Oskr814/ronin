import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../../platform/config/config.js';
import { log } from '../../platform/logger.js';
import { dropCloseNote, noteClosing } from '../portal/follow.js';
import { runAction } from './actions.js';
import { HISTORY_DAYS, itemKey } from '../runs/data.js';
import { runDecision } from './decision.js';
import { forgetDetails } from './detail.js';
import { forgetExploration } from '../explorations/review.js';
import { runApprove, runFichaAction, runGeneralComment } from '../explorations/review-actions.js';
import { fileContent, forgetFiles } from './files.js';
import { runFilesAction } from './files-actions.js';
import { forgetGithub, repoGithub } from './github.js';
import { itemRunKeys } from './list.js';
import { repoLinear } from './linear.js';
import { createFromDashboard, parseNewIssue, repoApps } from './new-issue.js';
import { pendingReview, viewedFiles } from '../../platform/github/github-as-user.js';
import { touchSeen } from '../access/team.js';
import { refusal, visibleRepos, visibleRuns } from '../access/visible.js';
import { anyObject, body, jsonBody, onError, onlyJson, repoParam } from '../../platform/http/middleware.js';
import type { DashboardEnv } from '../access/http.js';
import { detail, exploration, explorationContext, filesContext, itemContext, snapshot, todayWithCycles } from './service.js';

// The dashboard's heart (#65), in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them:
//   GET  /api/snapshot                       the sidebar and the status bar
//   GET  /api/today                          the last 12 hours' runs, the day's totals and the week's, and each repo's Linear cycle (#101)
//   POST /api/repos/<owner>/<repo>/issues    a new issue, as the person, and what to do with it (#100)
//   GET  /api/items/<id>                     one item's runs (14 days)
//   GET  /api/items/<id>/detail              its issue and PR from GitHub, with its comments and what can be asked of it (#85)
//   GET  /api/items/<id>/files               its PR's changed files and review threads, as "Files changed" (#111)
//   GET  /api/items/<id>/files/content?path= one of those files at the PR's head, for the lines around its hunks
//   GET  /api/items/<id>/files/mine          the person's own: the files they marked as viewed, and their pending review
//   GET  /api/items/<id>/exploration         an exploration PR's findings and their threads, to review them (#93)
//   POST /api/items/<id>/actions             asks for one of those (items/actions.ts)
//   POST /api/items/<id>/decision            on a PR ronin opened: approve and merge it, ask for an adjustment, or close it, as the person (#195)
//   POST /api/items/<id>/files/actions       a comment, a reply, resolving a thread, marking a file viewed, the review, as the person
//   POST /api/items/<id>/exploration/<what>  on its findings: actions on one, a general comment, the approval, as the person
// An item's id is "<owner>/<repo>#<n>", or "<repo>:<task>:<label>" for a run
// about neither; URI-encoded as one segment.

const NO_ITEM = { error: 'ese ítem no es un issue ni un PR de un repo de ronin' };
const NO_PR = { error: 'ese ítem no tiene un PR de un repo de ronin' };
const NO_EXPLORATION = { error: 'ese ítem no es un PR de exploración abierto de un repo de ronin' };
const MAX_BODY = 16 * 1024;

// A change only as JSON: a form from another site can't send it, on top of
// tailnet.ts's Origin check.

export function boardRoutes() {
  return new Hono<DashboardEnv>()
    .onError(onError)
    .get('/snapshot', async (c) => {
      await touchSeen(c.env.session.login);
      return c.json(await snapshot(c.env.access, c.env.session.login), 200);
    })
    .get('/today', async (c) => c.json(await todayWithCycles(c.env.access), 200))
    .post('/repos/:owner/:name/issues', onlyJson, jsonBody(MAX_BODY, 'falta el pedido'), anyObject(), async (c) => {
      const repo = repoParam(c);
      const entry = (await visibleRepos(c.env.access)).find((r) => r.productRepo === repo);
      if (!entry) return c.json({ error: 'ese repo no está en repos.json' }, 404);
      const refused = refusal(c, c.env.access, repo, 'acciones');
      if (refused) return refused;
      const linear = await repoLinear(entry, await repoGithub(entry));
      const issue = parseNewIssue(c.req.valid('json'), await repoApps(entry), linear?.planning);
      const created = await createFromDashboard(entry, c.env.session, issue, config.githubLogin);
      // The next snapshot lists it.
      forgetGithub(entry.productRepo);
      return c.json(created, 200);
    });
}

export function itemsRoutes() {
  return new Hono<DashboardEnv>()
    .onError(onError)
    // An issue ronin manages can have no runs in that window: an empty list.
    // Its slices' PR runs are its own too (itemRunKeys), as in the sidebar.
    .get('/:id', async (c) => {
      const id = c.req.param('id');
      const runs = await visibleRuns(c.env.access, HISTORY_DAYS);
      const entry = (await visibleRepos(c.env.access)).find((repo) => id.startsWith(`${repo.productRepo}#`));
      if (!entry && !runs.some((run) => itemKey(run) === id)) return c.json({ error: 'no existe ese ítem' }, 404);
      const keys = itemRunKeys(id, entry ? await repoGithub(entry) : undefined);
      return c.json({ id, runs: runs.filter((run) => keys.includes(itemKey(run))) }, 200);
    })
    .get('/:id/detail', async (c) => {
      const found = await detail(c.env.access, c.req.param('id'), c.env.session.login);
      return found ? c.json(found, 200) : c.json(NO_ITEM, 404);
    })
    .get('/:id/files', async (c) => {
      const ctx = await filesContext(c.env.access, c.req.param('id'));
      return ctx ? c.json({ pr: ctx.prNumber, ...ctx.files }, 200) : c.json(NO_PR, 404);
    })
    // Only a file the PR changes, so the endpoint can't read just anything from the repo.
    .get('/:id/files/content', async (c) => {
      const ctx = await filesContext(c.env.access, c.req.param('id'));
      if (!ctx) return c.json(NO_PR, 404);
      const path = c.req.query('path') ?? '';
      const file = ctx.files.files.find((f) => f.path === path);
      if (!file || file.status === 'removed' || !ctx.files.headSha) return c.json({ error: 'el PR no cambia ese archivo' }, 404);
      try {
        const text = await fileContent(ctx.entry, ctx.files.headSha, path);
        if (text === null) return c.json({ error: 'el archivo es demasiado grande para mostrarlo entero' }, 413);
        return c.json({ sha: ctx.files.headSha, text }, 200);
      } catch (error) {
        return c.json({ error: `GitHub no respondió: ${(error as Error).message.split('\n')[0]}` }, 502);
      }
    })
    // Each person's own: read with their token, never cached.
    .get('/:id/files/mine', async (c) => {
      const ctx = await filesContext(c.env.access, c.req.param('id'));
      if (!ctx) return c.json(NO_PR, 404);
      const { token } = c.env.session;
      const [viewed, review] = await Promise.all([viewedFiles(token, ctx.entry.productRepo, ctx.prNumber), pendingReview(token, ctx.entry.productRepo, ctx.prNumber)]);
      return c.json({ viewed, review }, 200);
    })
    .get('/:id/exploration', async (c) => {
      const found = await exploration(c.env.access, c.req.param('id'));
      return found ? c.json(found, 200) : c.json(NO_EXPLORATION, 404);
    })

    // { action, text?, app? }
    .post('/:id/actions', onlyJson, jsonBody(MAX_BODY, 'falta la acción'), body(z.object({ action: z.string({ error: 'falta la acción' }), text: z.unknown().optional(), app: z.unknown().optional() })), async (c) => {
      const { action, text, app } = c.req.valid('json');
      const ctx = await itemContext(c.env.access, c.req.param('id'));
      if (!ctx) return c.json(NO_ITEM, 404);
      const refused = refusal(c, c.env.access, ctx.entry.productRepo, 'acciones');
      if (refused) return refused;
      // Closing a portal request's issue with a reason: the person gets it
      // too, as when its PR is closed from the tablero (the decision).
      const reason = typeof text === 'string' ? text.trim() : '';
      const noted = action === 'close-issue' && ctx.ref.kind === 'issue' && reason
        ? await noteClosing(ctx.entry.productRepo, { issue: ctx.ref.number }, reason, c.env.session.login)
        : null;
      try {
        const done = await runAction(ctx.entry, ctx.ref, ctx.gh, ctx.detail, c.env.session, action, text, undefined, await repoApps(ctx.entry), app);
        // The next read shows the comment and whatever the action changed.
        forgetDetails(ctx.entry.productRepo);
        forgetFiles(ctx.entry.productRepo);
        // Taken, it moves to ronin's issues; closed, it leaves the list: read again on the next poll.
        if (action === 'assign' || action === 'close-issue') forgetGithub(ctx.entry.productRepo);
        return c.json(done, 200);
      } catch (error) {
        if (noted !== null) await dropCloseNote(noted).catch((e) => log.error(`tablero: no se pudo quitar el motivo del pedido P-${noted}`, e));
        throw error;
      }
    })

    // { decision: approve | adjust | close, text?, closeIssue? }
    .post('/:id/decision', onlyJson, jsonBody(MAX_BODY, 'falta el pedido'), anyObject(), async (c) => {
      const given = c.req.valid('json');
      const id = c.req.param('id');
      const [ctx, files] = await Promise.all([itemContext(c.env.access, id), filesContext(c.env.access, id)]);
      if (!ctx?.detail.pr || !files) return c.json(NO_PR, 404);
      const refused = refusal(c, c.env.access, ctx.entry.productRepo, 'acciones');
      if (refused) return refused;
      const issueNumber = ctx.ref.kind === 'issue' ? ctx.ref.number : ctx.ref.issue;
      // Closing it with its issue: the reason also goes to whoever asked for
      // it in the portal, kept before GitHub hears of it (follow.ts).
      const reason = typeof given.text === 'string' ? given.text.trim() : '';
      const noted = given.decision === 'close' && given.closeIssue === true && reason
        ? await noteClosing(ctx.entry.productRepo, { issue: issueNumber, pr: files.prNumber }, reason, c.env.session.login)
        : null;
      try {
        const done = await runDecision(ctx.entry, { prNumber: files.prNumber, ...(issueNumber !== undefined ? { issueNumber } : {}), files: files.files, pr: ctx.detail.pr }, c.env.session, given, config.githubLogin);
        // Its review, its comments, its state: all of it on the page and in the sidebar.
        forgetFiles(ctx.entry.productRepo);
        forgetDetails(ctx.entry.productRepo);
        forgetGithub(ctx.entry.productRepo);
        return c.json(done, 200);
      } catch (error) {
        if (noted !== null) await dropCloseNote(noted).catch((e) => log.error(`tablero: no se pudo quitar el motivo del pedido P-${noted}`, e));
        throw error;
      }
    })

    // { action: comment | reply | resolve | viewed | pending-… | submit, … }
    .post('/:id/files/actions', onlyJson, jsonBody(MAX_BODY, 'falta el pedido'), anyObject(), async (c) => {
      const given = c.req.valid('json');
      const ctx = await filesContext(c.env.access, c.req.param('id'));
      if (!ctx) return c.json(NO_PR, 404);
      // Marking a file as looked at is only the person's own.
      if (given.action !== 'viewed') {
        const refused = refusal(c, c.env.access, ctx.entry.productRepo, 'acciones');
        if (refused) return refused;
      }
      const done = await runFilesAction(ctx.entry, ctx.prNumber, ctx.files, c.env.session, given, config.githubLogin);
      // A viewed mark and a pending review are only the person's; the rest changes what everyone reads.
      if (!(given.action === 'viewed' || given.review || String(given.action).startsWith('pending-'))) {
        forgetFiles(ctx.entry.productRepo);
        forgetDetails(ctx.entry.productRepo);
      }
      // An approval or a request for changes is on the PR's chips: the next snapshot reads it.
      if (given.action === 'submit') forgetGithub(ctx.entry.productRepo);
      return c.json(done, 200);
    })

    // actions { action, ficha, text, redo? } on a finding, general { text }, approve { text? }
    .post('/:id/exploration/:what{actions|general|approve}', onlyJson, jsonBody(MAX_BODY, 'falta el pedido'), anyObject(), async (c) => {
      const given = c.req.valid('json');
      const ctx = await explorationContext(c.env.access, c.req.param('id'));
      if (!ctx) return c.json(NO_EXPLORATION, 404);
      const refused = refusal(c, c.env.access, ctx.entry.productRepo, 'acciones');
      if (refused) return refused;
      const what = c.req.param('what');
      const done = what === 'approve'
        ? await runApprove(ctx.entry, ctx.pr, ctx.review, c.env.session, given)
        : what === 'general'
          ? await runGeneralComment(ctx.entry, ctx.pr, c.env.session, given)
          : await runFichaAction(ctx.entry, ctx.pr, ctx.review, c.env.session, given);
      forgetExploration(ctx.entry.productRepo, ctx.pr.number);
      forgetDetails(ctx.entry.productRepo);
      forgetFiles(ctx.entry.productRepo);
      return c.json(done, 200);
    });
}
