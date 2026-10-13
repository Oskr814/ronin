import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ronin.app.json, at the root of the product repo: how to bring each of its
// apps up in a worktree so ronin can use it — see docs/DESIGN.md §11.2. It is
// read from the checkout being run, so a branch can change how its own app
// starts. Written by the repo's own team, so its commands get the same trust
// as the repo's CLAUDE.md: they run on this host.
export const APP_MANIFEST_FILE = 'ronin.app.json';

// One step of bringing an app up, run in order:
// - compose: start the manifest's compose files, with every published port
//   remapped to a free one (see app-runtime.ts's rewriteComposeConfig).
// - run: a command that has to finish (install, seed, migrate).
// - start: a long-running process (a dev server), stopped by appDown.
// - wait: poll a URL until it answers, e.g. an API that migrates on startup.
export type AppStep =
  | { compose: 'up' }
  | { run: string; name?: string; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  | { start: string; name: string; cwd?: string; env?: Record<string, string> }
  | { wait: string; name?: string; timeoutSeconds?: number };

// A step of the browser login, run with Playwright for each user — see
// app-browser.ts. `{{username}}`/`{{password}}` are filled per user.
export type LoginStep =
  | { goto: string }
  | { click: string }
  | { fill: string; value: string }
  | { waitForUrl: string }
  | { waitFor: string };

export interface AppUser {
  role: string;
  username: string;
  password: string;
  // Free text the team adds about who uses this role and how ("bodega lo
  // usa desde el teléfono") — exploration reads it as context.
  notes?: string;
}

export interface Viewport {
  width: number;
  height: number;
  isMobile?: boolean;
}

export interface AppDefinition {
  // The app's own directory in the repo — what exploration diffs to find
  // out which of its functions changed.
  path: string;
  compose?: { files: string[] };
  steps: AppStep[];
  baseUrl: string;
  // Where a logged-in user lands; exploration starts there.
  homePath?: string;
  users: AppUser[];
  login: LoginStep[];
  viewports: { desktop: Viewport; mobile: Viewport };
}

export interface AppManifest {
  apps: Record<string, AppDefinition>;
}

export const DEFAULT_VIEWPORTS: AppDefinition['viewports'] = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} falta o no es un string`);
  return value;
}

function optStr(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : str(value, where);
}

function optNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value > 0)) throw new Error(`${where} debe ser un número positivo`);
  return value;
}

function optEnv(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${where} debe ser un objeto de strings`);
  }
  return value as Record<string, string>;
}

function parseStep(raw: unknown, where: string): AppStep {
  if (!isObject(raw)) throw new Error(`${where} no es un objeto`);
  if ('compose' in raw) {
    if (raw.compose !== 'up') throw new Error(`${where}.compose solo admite "up"`);
    return { compose: 'up' };
  }
  if ('run' in raw) {
    return {
      run: str(raw.run, `${where}.run`),
      name: optStr(raw.name, `${where}.name`),
      cwd: optStr(raw.cwd, `${where}.cwd`),
      env: optEnv(raw.env, `${where}.env`),
      timeoutSeconds: optNumber(raw.timeoutSeconds, `${where}.timeoutSeconds`),
    };
  }
  if ('start' in raw) {
    return {
      start: str(raw.start, `${where}.start`),
      name: str(raw.name, `${where}.name`),
      cwd: optStr(raw.cwd, `${where}.cwd`),
      env: optEnv(raw.env, `${where}.env`),
    };
  }
  if ('wait' in raw) {
    return {
      wait: str(raw.wait, `${where}.wait`),
      name: optStr(raw.name, `${where}.name`),
      timeoutSeconds: optNumber(raw.timeoutSeconds, `${where}.timeoutSeconds`),
    };
  }
  throw new Error(`${where} no es un paso conocido (compose, run, start o wait)`);
}

function parseLoginStep(raw: unknown, where: string): LoginStep {
  if (!isObject(raw)) throw new Error(`${where} no es un objeto`);
  if ('goto' in raw) return { goto: str(raw.goto, `${where}.goto`) };
  if ('click' in raw) return { click: str(raw.click, `${where}.click`) };
  if ('fill' in raw) return { fill: str(raw.fill, `${where}.fill`), value: str(raw.value, `${where}.value`) };
  if ('waitForUrl' in raw) return { waitForUrl: str(raw.waitForUrl, `${where}.waitForUrl`) };
  if ('waitFor' in raw) return { waitFor: str(raw.waitFor, `${where}.waitFor`) };
  throw new Error(`${where} no es un paso de login conocido (goto, click, fill, waitForUrl o waitFor)`);
}

function parseViewport(raw: unknown, fallback: Viewport, where: string): Viewport {
  if (raw === undefined) return fallback;
  if (!isObject(raw)) throw new Error(`${where} no es un objeto`);
  return {
    width: optNumber(raw.width, `${where}.width`) ?? fallback.width,
    height: optNumber(raw.height, `${where}.height`) ?? fallback.height,
    isMobile: typeof raw.isMobile === 'boolean' ? raw.isMobile : fallback.isMobile,
  };
}

function parseApp(raw: unknown, where: string): AppDefinition {
  if (!isObject(raw)) throw new Error(`${where} no es un objeto`);
  let compose: AppDefinition['compose'];
  if (raw.compose !== undefined) {
    if (!isObject(raw.compose) || !Array.isArray(raw.compose.files) || raw.compose.files.length === 0) {
      throw new Error(`${where}.compose.files debe ser una lista no vacía`);
    }
    compose = { files: raw.compose.files.map((f, i) => str(f, `${where}.compose.files[${i}]`)) };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${where}.steps debe ser una lista no vacía`);
  const steps = raw.steps.map((s, i) => parseStep(s, `${where}.steps[${i}]`));
  if (steps.some((s) => 'compose' in s) && !compose) throw new Error(`${where}: hay un paso "compose" pero falta compose.files`);
  const starts = steps.flatMap((s) => ('start' in s ? [s.name] : []));
  if (new Set(starts).size !== starts.length) throw new Error(`${where}: dos pasos "start" con el mismo name`);

  if (!Array.isArray(raw.users) || raw.users.length === 0) throw new Error(`${where}.users debe ser una lista no vacía`);
  const users = raw.users.map((u, i) => {
    if (!isObject(u)) throw new Error(`${where}.users[${i}] no es un objeto`);
    return {
      role: str(u.role, `${where}.users[${i}].role`),
      username: str(u.username, `${where}.users[${i}].username`),
      password: str(u.password, `${where}.users[${i}].password`),
      notes: optStr(u.notes, `${where}.users[${i}].notes`),
    };
  });
  if (!Array.isArray(raw.login) || raw.login.length === 0) throw new Error(`${where}.login debe ser una lista no vacía`);

  const viewports = isObject(raw.viewports) ? raw.viewports : {};
  return {
    path: str(raw.path, `${where}.path`),
    compose,
    steps,
    baseUrl: str(raw.baseUrl, `${where}.baseUrl`),
    homePath: optStr(raw.homePath, `${where}.homePath`),
    users,
    login: raw.login.map((s, i) => parseLoginStep(s, `${where}.login[${i}]`)),
    viewports: {
      desktop: parseViewport(viewports.desktop, DEFAULT_VIEWPORTS.desktop, `${where}.viewports.desktop`),
      mobile: parseViewport(viewports.mobile, DEFAULT_VIEWPORTS.mobile, `${where}.viewports.mobile`),
    },
  };
}

export function parseAppManifest(raw: string): AppManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${APP_MANIFEST_FILE} no es JSON válido: ${(error as Error).message}`);
  }
  if (!isObject(parsed) || !isObject(parsed.apps) || Object.keys(parsed.apps).length === 0) {
    throw new Error(`${APP_MANIFEST_FILE} debe tener "apps" con al menos una app`);
  }
  const apps: Record<string, AppDefinition> = {};
  for (const [name, app] of Object.entries(parsed.apps)) apps[name] = parseApp(app, `${APP_MANIFEST_FILE}.apps.${name}`);
  return { apps };
}

export async function loadAppDefinition(checkoutDir: string, appName: string): Promise<AppDefinition> {
  let raw: string;
  try {
    raw = await readFile(join(checkoutDir, APP_MANIFEST_FILE), 'utf8');
  } catch {
    throw new Error(`no hay ${APP_MANIFEST_FILE} en ${checkoutDir} — ver docs/DESIGN.md §11.2`);
  }
  const app = parseAppManifest(raw).apps[appName];
  if (!app) throw new Error(`${APP_MANIFEST_FILE} no define la app "${appName}"`);
  return app;
}

// What a template in the manifest can reference: `{{ports.<service>.<port>}}`
// (the host port a compose service's container port was remapped to),
// `{{port.<name>}}` (a free port reserved by name, e.g. for a dev server),
// `{{compose}}` (the docker compose command for this app's stack, with its
// project and file) and `{{dir}}` (the checkout's absolute path).
//
// For whatever a browser reaches — the page itself, and the API it calls —
// `{{public.ports.<service>.<port>}}` and `{{public.port.<name>}}` render
// the URL that port answers on for whoever is looking at the app, and
// `{{publicHost}}` its host (for a dev server that checks the Host header).
// Normally that's http://127.0.0.1:<port>; in a /preview it's the runner's
// tailnet name over HTTPS, so another machine can use the app (see
// preview.ts).
export interface TemplateContext {
  ports: Record<string, Record<string, number>>;
  port: Record<string, number>;
  compose: string;
  dir: string;
  publicHost?: string;
}

const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function templateKeys(template: string): string[] {
  return [...template.matchAll(TEMPLATE_RE)].map((m) => m[1]);
}

// Names of the `{{port.<name>}}` (and `{{public.port.<name>}}`) a template
// uses, so the caller can reserve those ports before rendering it.
export function namedPortsIn(template: string): string[] {
  return templateKeys(template).flatMap((key) => {
    const bare = key.startsWith('public.') ? key.slice(7) : key;
    return bare.startsWith('port.') ? [bare.slice(5)] : [];
  });
}

function portOf(key: string[], ctx: TemplateContext): number | undefined {
  const [head, ...rest] = key;
  if (head === 'port' && rest.length === 1) return ctx.port[rest[0]];
  if (head === 'ports' && rest.length === 2) return ctx.ports[rest[0]]?.[rest[1]];
  return undefined;
}

export function publicUrl(port: number, ctx: Pick<TemplateContext, 'publicHost'>): string {
  return ctx.publicHost ? `https://${ctx.publicHost}:${port}` : `http://127.0.0.1:${port}`;
}

// The ports a template exposes through `{{public.…}}` — what a preview has
// to publish on the tailnet for the app to work from another machine.
export function publicPortsIn(template: string, ctx: TemplateContext): number[] {
  return templateKeys(template).flatMap((key) => {
    const [head, ...rest] = key.split('.');
    if (head !== 'public') return [];
    const port = portOf(rest, ctx);
    return port === undefined ? [] : [port];
  });
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(TEMPLATE_RE, (_, key: string) => {
    const [head, ...rest] = key.split('.');
    let value: unknown;
    if (head === 'compose' && rest.length === 0) value = ctx.compose;
    else if (head === 'dir' && rest.length === 0) value = ctx.dir;
    else if (head === 'publicHost' && rest.length === 0) value = ctx.publicHost ?? '127.0.0.1';
    else if (head === 'public') {
      const port = portOf(rest, ctx);
      value = port === undefined ? undefined : publicUrl(port, ctx);
    } else value = portOf([head, ...rest], ctx);
    if (value === undefined) throw new Error(`variable de plantilla desconocida: {{${key}}}`);
    return String(value);
  });
}
