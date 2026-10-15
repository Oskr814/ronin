import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { AppSession } from './runtime.js';
import type { AppUser, LoginStep, Viewport } from './manifest.js';

// The browser side of running an app: log each manifest user in once and
// keep the session (cookies + localStorage) as a Playwright storage state,
// so whoever uses the app next — the smoke check below, or the exploration
// agent's browser — starts already logged in as that role. See
// docs/DESIGN.md §11.2.

export type ViewportName = 'desktop' | 'mobile';

export function authStatePath(session: AppSession, role: string): string {
  return join(session.stateDir, 'auth', `${role.replace(/[^\w-]+/g, '_')}.json`);
}

export function absoluteUrl(baseUrl: string, target: string): string {
  return /^https?:\/\//.test(target) ? target : `${baseUrl}${target.startsWith('/') ? '' : '/'}${target}`;
}

export function fillCredentials(value: string, user: AppUser): string {
  return value.replaceAll('{{username}}', user.username).replaceAll('{{password}}', user.password);
}

export function contextOptions(viewport: Viewport) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    ...(viewport.isMobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
  };
}

export async function runLoginSteps(context: BrowserContext, baseUrl: string, steps: LoginStep[], user: AppUser): Promise<void> {
  const page = await context.newPage();
  for (const step of steps) {
    if ('goto' in step) await page.goto(absoluteUrl(baseUrl, step.goto));
    else if ('click' in step) await page.click(step.click);
    else if ('fill' in step) await page.fill(step.fill, fillCredentials(step.value, user));
    else if ('waitForUrl' in step) await page.waitForURL(step.waitForUrl, { timeout: 30_000 });
    else await page.waitForSelector(step.waitFor, { timeout: 30_000 });
  }
  await page.close();
}

// Logs every manifest user in and writes one storage state per role.
// Returns role → storage state path. Throws naming the role whose login
// failed: a manifest with wrong credentials or selectors must say so, not
// leave exploration wandering around a login page.
export async function loginAllUsers(session: AppSession): Promise<Record<string, string>> {
  const browser = await chromium.launch();
  try {
    const states: Record<string, string> = {};
    await mkdir(join(session.stateDir, 'auth'), { recursive: true });
    for (const user of session.app.users) {
      const context = await browser.newContext(contextOptions(session.app.viewports.desktop));
      try {
        await runLoginSteps(context, session.baseUrl, session.app.login, user);
        const path = authStatePath(session, user.role);
        await context.storageState({ path });
        states[user.role] = path;
      } catch (error) {
        throw new Error(`login de ${user.role} (${user.username}) falló: ${(error as Error).message}`);
      } finally {
        await context.close();
      }
    }
    return states;
  } finally {
    await browser.close();
  }
}

export interface SmokeShot {
  role: string;
  viewport: ViewportName;
  path: string;
  url: string;
  consoleErrors: string[];
}

// The proof that the app is usable the way exploration will use it: every
// role, logged in, on its home path, at each viewport — a screenshot and
// whatever the console complained about.
export async function smokeScreenshots(session: AppSession, authStates: Record<string, string>, outDir: string): Promise<SmokeShot[]> {
  await mkdir(outDir, { recursive: true });
  const browser: Browser = await chromium.launch();
  const shots: SmokeShot[] = [];
  try {
    for (const role of Object.keys(authStates)) {
      for (const viewport of ['desktop', 'mobile'] as const) {
        const context = await browser.newContext({ ...contextOptions(session.app.viewports[viewport]), storageState: authStates[role] });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        page.on('pageerror', (error) => consoleErrors.push(error.message));
        await page.goto(absoluteUrl(session.baseUrl, session.app.homePath ?? '/'));
        await page.waitForLoadState('networkidle').catch(() => {});
        const path = join(outDir, `${role}-${viewport}.png`);
        await page.screenshot({ path, fullPage: true });
        shots.push({ role, viewport, path, url: page.url(), consoleErrors });
        await context.close();
      }
    }
    return shots;
  } finally {
    await browser.close();
  }
}

// A self-contained HTML the explorer drew (an "after" it couldn't make on
// the real app) as a PNG at the app's viewport. It only loads local files:
// whatever else it asks for is blocked.
export async function renderHtmlToPng(htmlPath: string, pngPath: string, viewport: Viewport): Promise<void> {
  const browser = await chromium.launch();
  try {
    // Not emulating a phone: a drawn page rarely has a viewport meta tag, and
    // a phone would lay it out 980px wide.
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.isMobile ? 2 : 1 });
    await context.route('**/*', (route) => (/^(file|data):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}
