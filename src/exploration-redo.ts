import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { runAgentTask } from './agent-task.js';
import { appDown, appUp } from './app-runtime.js';
import { loginAllUsers, renderHtmlToPng } from './app-browser.js';
import { loadAppDefinition } from './app-manifest.js';
import { log } from './logger.js';
import { evidenceUrl, publishEvidence } from './evidence-store.js';
import { findingFileName, loadMemory, parseFinding, serializeFinding } from './exploration-memory.js';
import { explorationOutDir } from './exploration-inventory.js';
import { parseRedoResult, replaceAfterImage } from './exploration-output.js';
import { ensureCleanCheckout, mcpServer, originsOf } from './exploration-run.js';

// A reviewer said a finding's "after" image is wrong (exploration-flow.ts's
// feedback, "editar" with "rehacerDespues"): bring the app up, have an agent
// redo the after on the running app — one browser, at the finding's
// viewport and role — push the new image to the evidence branch and swap it
// into the finding. Runs in the exploration worker, like a run.

export interface RedoRequest {
  findingId: string;
  instruction: string;
}

// Returns the ids whose after was redone; the others failed and were logged.
export async function redoAfterImages(opts: { appName: string; codeDir: string; memoryDir: string; requests: RedoRequest[] }): Promise<string[]> {
  const app = await loadAppDefinition(opts.codeDir, opts.appName);
  const done: string[] = [];
  const session = await appUp(opts.codeDir, opts.appName);
  try {
    const authStates = await loginAllUsers(session);
    const origins = originsOf(session.baseUrl, session.ctx.ports, session.ctx.port);
    for (const request of opts.requests) {
      const meta = (await loadMemory(opts.memoryDir)).findings.find((f) => f.id === request.findingId);
      if (!meta || !authStates[meta.rol]) {
        log.error(`exploración: no encontré la ficha ${request.findingId} o su rol para rehacer el después`);
        continue;
      }
      const findingFile = join(opts.memoryDir, 'findings', findingFileName(meta));
      const outDir = join(explorationOutDir(), `redo-${opts.appName}-${meta.id}-${Date.now()}`);
      await mkdir(join(outDir, meta.viewport), { recursive: true });
      const mcpConfigPath = join(outDir, 'mcp.json');
      await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { browser: mcpServer(app, meta.viewport, authStates[meta.rol], join(outDir, meta.viewport), origins) } }, null, 2));
      const outputPath = join(outDir, 'result.json');
      try {
        await runAgentTask({
          type: 'explore-redo-after',
          appName: opts.appName,
          appPath: app.path,
          checkoutDir: opts.codeDir,
          outDir,
          outputPath,
          mcpConfigPath,
          baseUrl: session.baseUrl,
          homePath: app.homePath ?? '/',
          role: meta.rol,
          viewport: meta.viewport,
          findingId: meta.id,
          findingFile,
          instruction: request.instruction,
        });
        const result = parseRedoResult(await readFile(outputPath, 'utf8'), outDir);
        let src = result.imagen;
        if (/\.html?$/i.test(src)) {
          src = join(outDir, 'despues.png');
          await renderHtmlToPng(result.imagen, src, app.viewports[meta.viewport]);
        }
        const path = `${opts.appName}/redo/${meta.id}/despues-${Date.now()}${extname(src).toLowerCase()}`;
        const sha = await publishEvidence(opts.codeDir, [{ src, path }], `después rehecho de ${meta.id}`);
        const finding = parseFinding(await readFile(findingFile, 'utf8'));
        const body = replaceAfterImage(finding.body, { url: evidenceUrl(sha, path), ...(result.nota ? { nota: result.nota } : {}) }, meta.viewport);
        await writeFile(findingFile, serializeFinding({ ...finding, body }));
        done.push(meta.id);
      } catch (error) {
        log.error(`exploración: no se pudo rehacer el después de ${meta.id}`, error);
      } finally {
        await ensureCleanCheckout(opts.codeDir, app.path).catch((error) => log.error('exploración: no se pudo limpiar el checkout', error));
        await rm(mcpConfigPath, { force: true });
      }
    }
  } finally {
    await appDown(opts.codeDir);
  }
  return done;
}
