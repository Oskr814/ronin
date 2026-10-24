#!/usr/bin/env node
// The prototype's captures from a script (#411): the agent writes the steps
// to reach each screen once, and runs them before and after its draft,
// instead of driving the browser call by call. The browsers are the
// prototype's own (src/domains/portal/app-run.ts writes their config): the
// same logins, viewports and allowed origins as its MCP servers.
//
//   node ronin-shots.mjs <browsers.json> <script.json> antes|despues
//
// The script, written by the agent:
//
//   {"capturas": [{"n": 1, "navegador": "admin-desktop", "pasos": [
//     {"ir": "/orders/2"}, {"clic": "role=button[name=\"Ver\"]"},
//     {"escribir": "role=textbox[name=\"Buscar\"]", "texto": "Ana"},
//     {"esperar": "text=Pedido N° 2"}, {"ver": "role=table"}]}]}
//
// Each capture ends in <browser>/<phase>-<n>.png, the viewport as it is
// after its last step. Prints a JSON report; on a failed step, where it
// failed and the page's accessibility tree, to fix the selector and run it
// again. Exit 1 when any capture failed.
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const STEP_TIMEOUT = 5_000;
const MAX_TREE = 6_000;
const MAX_CAPTURES = 6;
const MAX_STEPS = 40;
const KINDS = ['ir', 'clic', 'escribir', 'esperar', 'ver', 'pausa'];

// The script as the agent wrote it, or why it can't run: never half of it.
export function parseScript(raw, browsers) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('el guion no es JSON'); }
  const captures = parsed?.capturas;
  if (!Array.isArray(captures) || !captures.length) throw new Error('el guion no trae "capturas"');
  if (captures.length > MAX_CAPTURES) throw new Error(`como mucho ${MAX_CAPTURES} capturas`);
  const seen = new Set();
  return captures.map((c, i) => {
    const where = `captura ${i + 1}`;
    if (!Number.isInteger(c?.n) || c.n < 1 || c.n > 9) throw new Error(`${where}: "n" va de 1 a 9`);
    if (!browsers[c.navegador]) throw new Error(`${where}: no hay un navegador "${c.navegador}" (hay: ${Object.keys(browsers).join(', ')})`);
    const key = `${c.navegador}/${c.n}`;
    if (seen.has(key)) throw new Error(`${where}: repite el número ${c.n} en ${c.navegador}`);
    seen.add(key);
    if (!Array.isArray(c.pasos) || c.pasos.length > MAX_STEPS) throw new Error(`${where}: "pasos" es una lista de hasta ${MAX_STEPS}`);
    const steps = c.pasos.map((p, j) => {
      const kind = KINDS.find((k) => p && typeof p === 'object' && k in p);
      if (!kind) throw new Error(`${where}, paso ${j + 1}: cada paso es uno de ${KINDS.join(', ')}`);
      if (kind === 'pausa') {
        if (!Number.isFinite(p.pausa) || p.pausa < 0 || p.pausa > 5_000) throw new Error(`${where}, paso ${j + 1}: "pausa" es de 0 a 5000 ms`);
      } else if (typeof p[kind] !== 'string' || !p[kind].trim()) throw new Error(`${where}, paso ${j + 1}: "${kind}" necesita un texto`);
      if (kind === 'escribir' && typeof p.texto !== 'string') throw new Error(`${where}, paso ${j + 1}: "escribir" necesita "texto"`);
      return kind === 'escribir' ? { kind, target: p.escribir, text: p.texto } : { kind, target: p[kind] };
    });
    return { n: c.n, browser: c.navegador, steps };
  });
}

// Only the app and its own services, like the MCP's --allowed-origins.
export function allowedUrl(url, origins) {
  if (!/^https?:/i.test(url)) return true;
  try { return origins.includes(new URL(url).origin); } catch { return false; }
}

// Where a path step goes: inside the app, never elsewhere.
export function targetUrl(path, baseUrl) {
  const url = new URL(path, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new Error(`"ir" va solo a la app (${new URL(baseUrl).origin}), no a ${url.origin}`);
  return url.href;
}

async function runStep(page, step, baseUrl) {
  const opts = { timeout: STEP_TIMEOUT };
  switch (step.kind) {
    case 'ir': await page.goto(targetUrl(step.target, baseUrl), { timeout: 30_000, waitUntil: 'load' }); await page.waitForLoadState('networkidle', opts).catch(() => {}); break;
    case 'clic': await page.locator(step.target).first().click(opts); break;
    case 'escribir': await page.locator(step.target).first().fill(step.text, opts); break;
    case 'esperar': await page.locator(step.target).first().waitFor({ ...opts, state: 'visible' }); break;
    case 'ver': await page.locator(step.target).first().scrollIntoViewIfNeeded(opts); break;
    case 'pausa': await page.waitForTimeout(step.target); break;
  }
}

async function capture(chromium, devices, config, capture, phase) {
  const b = config.browsers[capture.browser];
  // The full Chromium headless, like the rest of ronin (product-app/browser.ts): the
  // image has no headless shell.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({
      ...(b.mobile ? devices['iPhone 13'] : {}),
      viewport: b.viewport,
      storageState: b.storageState,
    });
    await context.route('**/*', (route) => (allowedUrl(route.request().url(), b.origins) ? route.continue() : route.abort()));
    const page = await context.newPage();
    for (const [i, step] of capture.steps.entries()) {
      try {
        await runStep(page, step, config.baseUrl);
      } catch (error) {
        const tree = await page.locator('body').ariaSnapshot({ timeout: 3_000 }).catch(() => '');
        return { n: capture.n, navegador: capture.browser, ok: false, paso: i + 1, error: String(error?.message ?? error).split('\n')[0], url: page.url(), pagina: tree.slice(0, MAX_TREE) };
      }
    }
    const file = join(b.outputDir, `${phase}-${capture.n}.png`);
    await page.screenshot({ path: file });
    return { n: capture.n, navegador: capture.browser, ok: true, imagen: relative(dirname(b.outputDir), file) };
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const [configPath, scriptPath, phase] = argv;
  if (!configPath || !scriptPath || !['antes', 'despues'].includes(phase)) {
    console.error('uso: node ronin-shots.mjs <browsers.json> <guion.json> antes|despues');
    return 2;
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  let captures;
  try {
    captures = parseScript(await readFile(scriptPath, 'utf8'), config.browsers);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    return 1;
  }
  const { chromium, devices } = await import('playwright');
  const results = [];
  for (const c of captures) results.push(await capture(chromium, devices, config, c, phase));
  const report = { ok: results.every((r) => r.ok), fase: phase, capturas: results };
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`ronin-shots: ${error?.message ?? error}`);
    process.exit(2);
  });
}
