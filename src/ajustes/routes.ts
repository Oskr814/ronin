import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { loadRepos } from '../core/repos.js';
import { AjustesError, ajustesView, conexionesView, linearTeams, readRegistro, saveNotificacion, saveProfile, setTask, setValue, testMail } from '../server/api/ajustes.js';
import { cuentasView, setCuenta } from '../server/api/cuentas-claude.js';
import { forgetGithub } from '../server/api/dashboard-github.js';
import { editRepo, reposView } from '../server/api/repos-admin.js';
import { addUsuario, removeUsuario, updateEquipo, updateUsuario, usuariosView, usuarioView } from '../server/api/usuarios.js';
import { visibleRepos } from '../server/api/visible.js';
import { body, jsonBody, onError, type DashboardEnv } from '../server/hono.js';

// Ajustes (#174) from the dashboard, in Hono (#235, stage 6) — server/
// dashboard-app.ts mounts them under /api/ajustes. The profile and the
// notifications are everyone's own; the rest, admins only:
//   GET  /                        the person's profile, and for admins the settings (ajustes.ts)
//   GET  /registro                every change made in Ajustes
//   GET  /conexiones              GitHub, Linear, the mail…, and whether each works
//   POST /conexiones/correo       a test mail to whoever asks
//   GET  /repos                   the repos of repos.json (repos-admin.ts)
//   POST /repos/<owner>/<repo>    edits one
//   GET  /cuentas                 the Claude accounts and their plans (#234, cuentas-claude.ts)
//   POST /cuentas/<cuenta>        sets an account's plan
//   GET  /usuarios[/<login>]      the team: its people, or one of them (usuarios.ts)
//   POST /usuarios                adds someone
//   POST /usuarios/<login>        changes what they can do
//   POST /usuarios/<login>/quitar takes them off
//   POST /equipo                  the team's defaults
//   POST /perfil                  the person's own profile
//   POST /notificaciones          which mails the person gets
//   POST /tareas                  a task type's model and effort
//   POST /valores                 one setting's value
// Each body is checked by its service, which says what's wrong in words.

// Only admins, with what they'd be doing.
const admins = (refusal: string) => async (c: Context<DashboardEnv>, next: Next) => (c.env.access.admin ? next() : c.json({ error: refusal }, 403));

// A change only as JSON, which a plain HTML form can't send.
const asJson = async (c: Context<DashboardEnv>, next: Next) => ((c.req.header('content-type') ?? '').startsWith('application/json') ? next() : c.json({ error: 'se espera JSON' }, 415));

export function ajustesRoutes() {
  const json = () => jsonBody(256 * 1024, 'el pedido no llegó bien');
  const fields = () => body(z.record(z.string(), z.unknown()));
  const repos = admins('solo los administradores cambian los repos');
  const cuentas = admins('solo los administradores ven las cuentas de Claude');
  const usuarios = admins('solo los administradores manejan los usuarios');
  const settings = admins('solo los administradores cambian los ajustes');
  return new Hono<DashboardEnv>()
    .onError(onError([AjustesError]))
    .get('/', async (c) => c.json(await ajustesView(c.env.session.login, c.env.access.admin, await visibleRepos(c.env.access)), 200))
    .get('/registro', admins('solo los administradores ven el registro'), async (c) => c.json({ registro: await readRegistro() }, 200))
    .get('/conexiones', admins('solo los administradores ven las conexiones'), async (c) => c.json(await conexionesView(), 200))
    .post('/conexiones/correo', admins('solo los administradores ven las conexiones'), async (c) => c.json(await testMail(c.env.session.login), 200))

    .get('/repos', repos, async (c) => c.json(await reposView(await loadRepos()), 200))
    .post('/repos/:owner/:name', repos, asJson, json(), fields(), async (c) => {
      const repo = `${c.req.param('owner')}/${c.req.param('name')}`;
      const out = await editRepo(c.env.session.login, repo, c.req.valid('json'), await loadRepos());
      forgetGithub(repo);
      return c.json(out, 200);
    })

    .get('/cuentas', cuentas, async (c) => c.json(await cuentasView(await loadRepos()), 200))
    .post('/cuentas/:account', cuentas, asJson, json(), fields(), async (c) => c.json(await setCuenta(c.env.session.login, c.req.param('account'), c.req.valid('json'), await loadRepos()), 200))

    .get('/usuarios', usuarios, async (c) => c.json(await usuariosView(await loadRepos()), 200))
    .get('/usuarios/:login', usuarios, async (c) => {
      const view = await usuarioView(c.req.param('login') ?? '', await loadRepos());
      return view ? c.json(view, 200) : c.json({ error: 'esa persona no está en la lista' }, 404);
    })
    .post('/usuarios', usuarios, asJson, json(), fields(), async (c) => c.json(await addUsuario(c.env.session.login, c.req.valid('json')), 200))
    .post('/usuarios/:login/quitar', usuarios, asJson, async (c) => c.json(await removeUsuario(c.env.session.login, c.req.param('login') ?? ''), 200))
    .post('/usuarios/:login', usuarios, asJson, json(), fields(), async (c) => c.json(await updateUsuario(c.env.session.login, c.req.param('login'), c.req.valid('json'), await loadRepos()), 200))
    .post('/equipo', usuarios, asJson, json(), fields(), async (c) => c.json(await updateEquipo(c.env.session.login, c.req.valid('json')), 200))

    .post('/perfil', asJson, json(), fields(), async (c) => c.json(await saveProfile(c.env.session.login, c.req.valid('json'), await linearTeams(await visibleRepos(c.env.access))), 200))
    .post('/notificaciones', asJson, json(), fields(), async (c) => c.json(await saveNotificacion(c.env.session.login, c.req.valid('json'), await visibleRepos(c.env.access)), 200))
    .post('/tareas', asJson, json(), fields(), settings, async (c) => c.json(await setTask(c.env.session.login, c.req.valid('json')), 200))
    .post('/valores', asJson, json(), fields(), settings, async (c) => c.json(await setValue(c.env.session.login, c.req.valid('json')), 200));
}
