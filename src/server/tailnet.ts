import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAuth, sessionLogin, type AuthConfig, type GithubOAuth } from './api/auth.js';
import { handleDashboard } from './api/dashboard.js';
import { handleGithubWebhook } from './api/webhooks/github.js';
import { GITHUB_WEBHOOK_PATHS } from './public.js';

// What the tailnet listener serves (#65): the whole API under /api and the
// web app (src/web/) everywhere else. Only the tailnet reaches it — it
// listens on 127.0.0.1 and `tailscale serve` publishes it — and on top of
// that, everything but the login asks for a GitHub session.

// src/web/ in development (tsx), dist/web/ once built (`pnpm build` copies it).
export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Inline style attributes are allowed (the app sets widths and colors with
// them); scripts only from the app's own files.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function serveStatic(path: string, res: ServerResponse, root: string): void {
  let file: string;
  try {
    file = resolve(root, `.${decodeURIComponent(path)}`);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  // An app route (/i/<item>) gets the app itself; a missing file, a 404.
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(path)) {
      res.writeHead(404).end();
      return;
    }
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(readFileSync(file));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createTailnetHandler(auth: AuthConfig, options: { github?: GithubOAuth; webRoot?: string } = {}): Handler {
  const root = options.webRoot ?? WEB_ROOT;
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
      if (await handleAuth(req, res, path, auth, options.github)) return;
      const login = sessionLogin(req, auth);
      if (!login) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'sin sesión' }));
        return;
      }
      if (await handleDashboard(req, res, path, login)) return;
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
