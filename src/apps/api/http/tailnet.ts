import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAuth, readSession, type AuthConfig, type GithubOAuth } from './auth.js';
import type { Session } from '@domains/access/http.js';
import type { Access } from '@domains/access/access.js';
import { teamAccess } from '@domains/access/team.js';
import { GithubUserError } from '@platform/github/github-as-user.js';
import { loadRepos } from '@platform/config/repos.js';
import { handleDashboard } from './dashboard.js';
import { handleGithubWebhook } from '../webhooks/github.js';
import { GITHUB_WEBHOOK_PATHS } from './public.js';
import { serveStatic, WEB_ROOT } from './static.js';

// What the tailnet listener serves (#65): the whole API under /api and the
// web app (src/apps/dashboard/public/) everywhere else. Only the tailnet reaches it — it
// listens on 127.0.0.1 and `tailscale serve` publishes it — and on top of
// that, everything but the login asks for a GitHub session.

// Inline style attributes are allowed (the app sets widths and colors with
// them); scripts only from the app's own files.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

// The repos a session sees (access/access.ts), from repos.json.
type AccessOf = (session: Session) => Promise<Access>;

export function createTailnetHandler(auth: AuthConfig, options: { github?: GithubOAuth; webRoot?: string; access?: AccessOf } = {}): Handler {
  const root = options.webRoot ?? WEB_ROOT;
  // The team in Ajustes (#174, access/team.ts) on top of GitHub's answer: its admins, hidden repos and permissions.
  const accessOf: AccessOf = options.access ?? (async (session) => teamAccess(session, await loadRepos()));
  // At login, past the lists: an admin, or someone with a repo to see.
  const canEnter = async (login: string, token: string) => {
    const access = await accessOf({ login, token });
    return access.admin || access.repos.length > 0;
  };
  return async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';

    // GitHub's deliveries work here too: the same handler, its own signature.
    if (method === 'POST' && GITHUB_WEBHOOK_PATHS.includes(path)) {
      await handleGithubWebhook(req, res);
      return;
    }

    // A change asked from another site never goes through, whatever its cookies.
    const origin = req.headers.origin;
    if (method !== 'GET' && method !== 'HEAD' && origin !== undefined && origin !== auth.url) {
      res.writeHead(403).end();
      return;
    }

    if (path.startsWith('/api/')) {
      if (await handleAuth(req, res, path, auth, options.github, canEnter)) return;
      const session = readSession(req, auth);
      const unauthorized = (error: string) => res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error }));
      if (!session) {
        unauthorized('sin sesión');
        return;
      }
      // Which repos it sees (#106): every request, so someone taken off a
      // repo on GitHub stops seeing it within the cache's minutes. With none
      // left, it's as good as no session: the page asks to log in, and the
      // login says why it can't.
      let access: Access;
      try {
        access = await accessOf(session);
      } catch (error) {
        if (error instanceof GithubUserError) {
          unauthorized(error.message);
          return;
        }
        throw error;
      }
      if (!access.admin && access.repos.length === 0) {
        unauthorized('tu usuario de GitHub ya no puede ver ningún repo de este tablero');
        return;
      }
      if (await handleDashboard(req, res, path, session, access)) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'no existe' }));
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(path, res, root);
  };
}
