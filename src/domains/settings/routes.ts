import { Hono } from 'hono';
import { loadRepos } from '@platform/config/repos.js';
import { settingsPageView, connectionsView, linearTeams, readSettingsLog, saveNotifications, saveProfile, setTask, setValue, testMail } from './settings.js';
import { accountsView, resetApiBudget, setAccountPlan } from './claude-accounts.js';
import { forgetGithub } from '../items/github.js';
import { editRepo, reposView } from './repos.js';
import { addUser, removeUser, updateTeamDefaults, updateUser, usersView, userView } from './users.js';
import { visibleRepos } from '../access/visible.js';
import { adminsOnly, anyObject, jsonBody, onError, onlyJson, repoParam } from '@platform/http/middleware.js';
import type { DashboardEnv } from '../access/http.js';

// Ajustes (#174) from the dashboard, in Hono (#235, stage 6) — server/
// apps/api/routes.ts mounts them under /api/settings. The profile and the
// notifications are everyone's own; the rest, admins only:
//   GET  /                        the person's profile, and for admins the settings (settings/settings.ts)
//   GET  /log                     every change made in Ajustes
//   GET  /connections             GitHub, Linear, the mail…, and whether each works
//   POST /connections/mail        a test mail to whoever asks
//   GET  /repos                   the repos of repos.json (settings/repos.ts)
//   POST /repos/<owner>/<repo>    edits one
//   GET  /accounts                the Claude accounts and their plans (#234, settings/claude-accounts.ts)
//   POST /accounts/<account>      sets an account's plan
//   POST /api-budget/<owner>/<repo>/reset   what a repo spent by API back to zero (#421)
//   GET  /users[/<login>]         the team: its people, or one of them (settings/users.ts)
//   POST /users                   adds someone
//   POST /users/<login>           changes what they can do
//   POST /users/<login>/remove    takes them off
//   POST /team                    the team's defaults
//   POST /profile                 the person's own profile
//   POST /notifications           which mails the person gets
//   POST /tasks                   a task type's model and effort
//   POST /values                  one setting's value
// Each body is checked by its service, which says what's wrong in words.


// A change only as JSON, which a plain HTML form can't send.

export function settingsRoutes() {
  const json = () => jsonBody(256 * 1024, 'el pedido no llegó bien');
  const repos = adminsOnly('solo los administradores cambian los repos');
  const accounts = adminsOnly('solo los administradores ven las cuentas de Claude');
  const users = adminsOnly('solo los administradores manejan los usuarios');
  const settings = adminsOnly('solo los administradores cambian los ajustes');
  return new Hono<DashboardEnv>()
    .onError(onError)
    .get('/', async (c) => c.json(await settingsPageView(c.env.session.login, c.env.access.admin, await visibleRepos(c.env.access)), 200))
    .get('/log', adminsOnly('solo los administradores ven el registro'), async (c) => c.json({ registro: await readSettingsLog() }, 200))
    .get('/connections', adminsOnly('solo los administradores ven las conexiones'), async (c) => c.json(await connectionsView(), 200))
    .post('/connections/mail', adminsOnly('solo los administradores ven las conexiones'), async (c) => c.json(await testMail(c.env.session.login), 200))

    .get('/repos', repos, async (c) => c.json(await reposView(await loadRepos()), 200))
    .post('/repos/:owner/:name', repos, onlyJson, json(), anyObject(), async (c) => {
      const repo = repoParam(c);
      const out = await editRepo(c.env.session.login, repo, c.req.valid('json'), await loadRepos());
      forgetGithub(repo);
      return c.json(out, 200);
    })

    .get('/accounts', accounts, async (c) => c.json(await accountsView(await loadRepos()), 200))
    .post('/accounts/:account', accounts, onlyJson, json(), anyObject(), async (c) => c.json(await setAccountPlan(c.env.session.login, c.req.param('account'), c.req.valid('json'), await loadRepos()), 200))
    .post('/api-budget/:owner/:name/reset', accounts, onlyJson, async (c) => c.json(await resetApiBudget(c.env.session.login, repoParam(c), await loadRepos()), 200))

    .get('/users', users, async (c) => c.json(await usersView(await loadRepos()), 200))
    .get('/users/:login', users, async (c) => {
      const view = await userView(c.req.param('login') ?? '', await loadRepos());
      return view ? c.json(view, 200) : c.json({ error: 'esa persona no está en la lista' }, 404);
    })
    .post('/users', users, onlyJson, json(), anyObject(), async (c) => c.json(await addUser(c.env.session.login, c.req.valid('json')), 200))
    .post('/users/:login/remove', users, onlyJson, async (c) => c.json(await removeUser(c.env.session.login, c.req.param('login') ?? ''), 200))
    .post('/users/:login', users, onlyJson, json(), anyObject(), async (c) => c.json(await updateUser(c.env.session.login, c.req.param('login'), c.req.valid('json'), await loadRepos()), 200))
    .post('/team', users, onlyJson, json(), anyObject(), async (c) => c.json(await updateTeamDefaults(c.env.session.login, c.req.valid('json')), 200))

    .post('/profile', onlyJson, json(), anyObject(), async (c) => c.json(await saveProfile(c.env.session.login, c.req.valid('json'), await linearTeams(await visibleRepos(c.env.access))), 200))
    .post('/notifications', onlyJson, json(), anyObject(), async (c) => c.json(await saveNotifications(c.env.session.login, c.req.valid('json'), await visibleRepos(c.env.access)), 200))
    .post('/tasks', onlyJson, json(), anyObject(), settings, async (c) => c.json(await setTask(c.env.session.login, c.req.valid('json')), 200))
    .post('/values', onlyJson, json(), anyObject(), settings, async (c) => c.json(await setValue(c.env.session.login, c.req.valid('json')), 200));
}
