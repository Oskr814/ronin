import type { ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The static files of the server's two web apps: the dashboard (src/web/,
// tailnet.ts) and the request portal (src/portal-web/, portal.ts). In
// development (tsx) they're read from src/, once built from dist/ (`pnpm
// build` copies both).
const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(HERE, '..', 'web');
export const PORTAL_WEB_ROOT = resolve(HERE, '..', 'portal-web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// A file under root, or the app's index.html for an app route (a path with
// no extension: /i/<item>, /contrasena); anything else is a 404, and nothing
// outside root is ever served.
export function serveStatic(path: string, res: ServerResponse, root: string): void {
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
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(path)) {
      res.writeHead(404).end();
      return;
    }
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(readFileSync(file));
}
