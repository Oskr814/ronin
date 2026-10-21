import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The static files of the server's two web apps, as Vite builds them
// (`pnpm build`) into dist/public/: the dashboard (apps/dashboard, served by
// tailnet.ts) and the request portal (apps/portal, by portal.ts). From dist/
// whether the server runs built or with tsx (`pnpm server`): to work on a
// page, rebuild it, or `pnpm portal:dev` for the portal.
const HERE = dirname(fileURLToPath(import.meta.url));
// dist/apps/api/http, or src/apps/api/http with tsx.
const ROOT = resolve(HERE, '..', '..', '..', '..');
const PUBLIC = join(ROOT, 'dist', 'public');
export const WEB_ROOT = join(PUBLIC, 'dashboard');
export const PORTAL_WEB_ROOT = join(PUBLIC, 'portal');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Cloudflare, in front of the public listener, gives the JS and CSS its own
// browser cache time (4 hours) over our no-cache: after a deploy, a browser
// would keep running the old ones. So the index.html names each with its
// content's hash (`/portal.js?v=1a2b3c4d5e`): a change is a new URL. The
// HTML itself isn't cached.
const versions = new Map<string, { mtimeMs: number; v: string }>();

function version(file: string): string {
  const { mtimeMs } = statSync(file);
  const cached = versions.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.v;
  const v = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
  versions.set(file, { mtimeMs, v });
  return v;
}

export function withVersions(html: string, root: string): string {
  return html.replace(/(href|src)="\/([\w./-]+\.(?:js|css))"/g, (whole, attr: string, path: string) => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file)) return whole;
    return `${attr}="/${path}?v=${version(file)}"`;
  });
}

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
  const body = extname(file) === '.html' ? withVersions(readFileSync(file, 'utf8'), root) : readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
}
