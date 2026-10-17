import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadRepos } from '../core/repos.js';
import { handlePortalApi, type PortalConfig, type PortalDeps } from './api/portal.js';
import { extname, join } from 'node:path';
import { PORTAL_WEB_ROOT, serveStatic, WEB_ROOT } from './static.js';

// The request portal (#114) on the public listener: its web app
// (src/portal-web/) and its API (/api/portal/*), and nothing of the
// dashboard's. The fonts are the dashboard's own files, served from there.

// Inline style attributes are allowed, as in the dashboard; images also from
// blob: (the ones a person attaches, shown before sending them).
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

// What's missing for the portal to run; empty means it can.
export function missingPortalConfig(config: PortalConfig): string[] {
  const missing: string[] = [];
  if (!config.url) missing.push('PORTAL_URL');
  if (config.sessionSecret.length < 32) missing.push('PORTAL_SESSION_SECRET (32+ caracteres)');
  return missing;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createPortalHandler(config: PortalConfig, options: { webRoot?: string; fontsRoot?: string; deps?: Partial<PortalDeps> } = {}): Handler {
  const root = options.webRoot ?? PORTAL_WEB_ROOT;
  const fonts = options.fontsRoot ?? join(WEB_ROOT, 'fonts');
  const deps: PortalDeps = { entries: loadRepos, ...options.deps };
  return async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';

    // A change asked from another site never goes through, whatever its
    // cookies; and only as JSON, which a plain HTML form can't send.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if ((origin !== undefined && origin !== config.url) || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(403).end();
        return;
      }
    }

    if (path.startsWith('/api/')) {
      if (path.startsWith('/api/portal/') && (await handlePortalApi(req, res, path, config, deps))) return;
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'no existe' }));
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    // Only the fonts folder: nothing else of the dashboard's is reachable from here.
    if (path.startsWith('/fonts/')) {
      if (extname(path)) serveStatic(path.slice('/fonts'.length), res, fonts);
      else res.writeHead(404).end();
    } else serveStatic(path, res, root);
  };
}
