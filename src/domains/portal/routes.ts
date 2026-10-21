import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { log } from '../../platform/logger.js';
import { body, jsonBody, onError, type NodeEnv } from '../../apps/api/http/hono.js';
import { findUserByEmail, normalizeEmail, recordLogin, redeemLink, userForLink, type PortalUser } from './accounts.js';
import { grantedApps } from './apps.js';
import { ImageError } from './images.js';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from './password.js';
import { RateLimit } from './rate-limit.js';
import { RequestError, startedToday } from './requests.js';
import { requestRoutes } from './routes-requests.js';
import { sendPasswordLink } from './send-link.js';
import { portalCookie, sealPortalSession } from './session.js';
import { clientIp, portalUser, type PortalConfig, type PortalDeps } from './http.js';

// The request portal's API (#114), on the public listener, in Hono (#235,
// stage 6) — apps/api/http/portal.ts mounts it under /api/portal:
//   POST /login     { email, password }: the session cookie
//   POST /logout
//   GET  /me        who's in, and the apps they can ask in
//   POST /forgot    { email }: a link to change the password, if the account exists
//   POST /link      { token }: whose password a link sets, while it's good
//   POST /password  { token, password }: sets it with the link, and logs in
//   /requests…      the person's requests and their conversation (routes-requests.ts)
//
// It answers the same to an unknown email and a wrong password, and takes as
// long, so the login doesn't tell which emails have an account; the same for
// a reset asked for an email without one.

const WINDOW_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
// Failed logins: per email, what stops guessing one account's password; per
// IP, what stops trying many.
const loginByEmail = new RateLimit(5, WINDOW_MS);
const loginByIp = new RateLimit(30, WINDOW_MS);
const forgotByEmail = new RateLimit(3, HOUR_MS);
const forgotByIp = new RateLimit(10, HOUR_MS);
const linkByIp = new RateLimit(20, WINDOW_MS);

const TOO_MANY = 'Demasiados intentos. Prueba de nuevo en unos minutos.';
const BAD_LOGIN = 'Correo o contraseña incorrectos.';
const BAD_LINK = 'El enlace venció o ya se usó. Pide uno nuevo desde "¿Olvidaste tu contraseña?".';
const BAD_BODY = 'pedido inválido';
const MAX_BODY = 8 * 1024;

// For the tests, which log in many times.
export function resetPortalLimits(): void {
  for (const limit of [loginByEmail, loginByIp, forgotByEmail, forgotByIp, linkByIp]) limit.reset();
}

function sessionCookie(user: PortalUser, config: PortalConfig): string {
  return portalCookie(sealPortalSession({ userId: user.id, version: user.sessionVersion }, config.sessionSecret, config.sessionDays), config.sessionDays * 24 * 60 * 60);
}

async function me(user: PortalUser, config: PortalConfig, deps: PortalDeps) {
  const limit = user.dailyLimit ?? config.dailyLimit;
  return { name: user.name, email: user.email, apps: grantedApps(user.grants, await deps.entries()), today: { used: await startedToday(user.id), limit } };
}

// Whatever comes that isn't a string counts as an empty one, as the checks
// below expect (an empty email is a failed login, not a 400).
const text = z.unknown().optional().transform((value) => (typeof value === 'string' ? value : ''));
const json = () => jsonBody(MAX_BODY, BAD_BODY);
const tooMany = (c: Context) => c.json({ error: TOO_MANY }, 429);

// Only POST on the paths below: another method is a 405, not a missing page.
const POSTS = ['/login', '/forgot', '/link', '/password'];

export function portalRoutes(config: PortalConfig, deps: PortalDeps) {
  const routes = new Hono<NodeEnv>()
    .onError(onError([RequestError, ImageError]))
    .notFound((c) => c.json({ error: 'no existe' }, 404))

    .get('/me', async (c) => {
      const user = await portalUser(c.env.incoming, config);
      if (user) return c.json(await me(user, config, deps), 200);
      c.header('Set-Cookie', portalCookie('', 0));
      return c.json({ error: 'sin sesión' }, 401);
    })

    .post('/logout', (c) => {
      c.header('Set-Cookie', portalCookie('', 0));
      return c.body(null, 204);
    })

    .post('/login', json(), body(z.object({ email: text, password: text })), async (c) => {
      const { email: given, password } = c.req.valid('json');
      const email = normalizeEmail(given);
      const ip = clientIp(c.env.incoming);
      if (loginByEmail.blocked(email) || loginByIp.blocked(ip)) return tooMany(c);
      const user = email ? await findUserByEmail(email) : undefined;
      const ok = user?.passwordHash && !user.disabled ? await verifyPassword(password, user.passwordHash) : (await burnPasswordCheck(password), false);
      if (!ok || !user) {
        loginByEmail.hit(email);
        loginByIp.hit(ip);
        log.info(`portal: login fallido para ${email || '(sin correo)'} desde ${ip}`);
        return c.json({ error: BAD_LOGIN }, 401);
      }
      loginByEmail.clear(email);
      await recordLogin(user.id);
      log.info(`portal: ${user.email} entró`);
      c.header('Set-Cookie', sessionCookie(user, config));
      return c.json(await me(user, config, deps), 200);
    })

    .post('/forgot', json(), body(z.object({ email: text })), async (c) => {
      const email = normalizeEmail(c.req.valid('json').email);
      const ip = clientIp(c.env.incoming);
      if (forgotByIp.blocked(ip) || forgotByEmail.blocked(email)) return tooMany(c);
      forgotByIp.hit(ip);
      forgotByEmail.hit(email);
      const user = email ? await findUserByEmail(email) : undefined;
      // An account still waiting on its invitation gets a new invitation.
      if (user && !user.disabled) await sendPasswordLink(user, user.passwordHash ? 'reset' : 'invite', { portalUrl: config.url, entries: await deps.entries(), send: deps.send });
      return c.body(null, 204);
    })

    .post('/link', json(), body(z.object({ token: text })), async (c) => {
      const { token } = c.req.valid('json');
      const ip = clientIp(c.env.incoming);
      if (linkByIp.blocked(ip)) return tooMany(c);
      const user = token ? await userForLink(token) : undefined;
      if (!user?.link) {
        linkByIp.hit(ip);
        return c.json({ error: BAD_LINK }, 404);
      }
      return c.json({ name: user.name, email: user.email, kind: user.link.kind }, 200);
    })

    .post('/password', json(), body(z.object({ token: text, password: z.unknown().optional() })), async (c) => {
      const { token, password } = c.req.valid('json');
      const ip = clientIp(c.env.incoming);
      if (linkByIp.blocked(ip)) return tooMany(c);
      const problem = passwordProblem(password);
      if (problem) return c.json({ error: problem }, 400);
      const user = token ? await redeemLink(token, await hashPassword(password as string)) : undefined;
      if (!user) {
        linkByIp.hit(ip);
        return c.json({ error: BAD_LINK }, 404);
      }
      loginByEmail.clear(user.email);
      await recordLogin(user.id);
      log.info(`portal: ${user.email} puso su contraseña`);
      c.header('Set-Cookie', sessionCookie(user, config));
      return c.json(await me(user, config, deps), 200);
    })

    .route('/requests', requestRoutes(config, deps));
  // Outside the chain above, which is the type the client sees: it only
  // calls these with POST.
  routes.on(['GET', 'PUT', 'PATCH', 'DELETE'], POSTS, (c) => c.json({ error: 'método no permitido' }, 405));
  return routes;
}

export type PortalApi = ReturnType<typeof portalRoutes>;
