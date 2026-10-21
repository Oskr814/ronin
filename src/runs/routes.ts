import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { sees } from '../server/api/access.js';
import { readRunLines, runPath, summarizeRun } from '../server/api/dashboard-data.js';
import { readEvidence } from '../server/api/dashboard-evidence.js';
import { visibleRepos } from '../server/api/visible.js';
import type { DashboardEnv } from '../server/hono.js';

// The runs from the dashboard (#65), in Hono (#235, stage 6) — server/
// dashboard-app.ts mounts them:
//   GET /api/runs/<runId>          one run's transcript
//   GET /api/runs/<runId>/stream   the rest of it as it happens (SSE), from ?from=<line>
//   GET /api/evidence/<owner>/<repo>/<sha>/<path>  a screenshot a run published (dashboard-evidence.ts)

const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 15_000;

export function runsRoutes() {
  // The run's file, if the session sees its repo: one it doesn't see is as
  // good as missing.
  const visibleRun = (runId: string, access: DashboardEnv['Bindings']['access']) => {
    const file = runPath(runId);
    const summary = file && existsSync(file) ? summarizeRun(readRunLines(file)) : null;
    return file && summary && sees(access, summary.repo) ? { file, summary } : null;
  };
  const missing = { error: 'no existe esa corrida' };
  return new Hono<DashboardEnv>()
    .get('/:runId', (c) => {
      const run = visibleRun(c.req.param('runId'), c.env.access);
      if (!run) return c.json(missing, 404);
      return c.json({ summary: run.summary, lines: readRunLines(run.file) }, 200);
    })
    // Each new line as an event, every second; `end` with how it ended once
    // it did, and a comment now and then so no proxy takes it for dead.
    .get('/:runId/stream', (c) => {
      const run = visibleRun(c.req.param('runId'), c.env.access);
      if (!run) return c.json(missing, 404);
      const from = Number(c.req.query('from') ?? 0);
      c.header('Cache-Control', 'no-store');
      return streamSSE(c, async (stream) => {
        let sent = Number.isInteger(from) && from >= 0 ? from : 0;
        let lastWrite = Date.now();
        let open = true;
        stream.onAbort(() => {
          open = false;
        });
        while (open) {
          let lines;
          try {
            lines = readRunLines(run.file);
          } catch {
            return;
          }
          for (const line of lines.slice(sent)) {
            await stream.writeSSE({ data: JSON.stringify(line) });
            lastWrite = Date.now();
          }
          sent = Math.max(sent, lines.length);
          const summary = summarizeRun(lines);
          if (!summary || summary.state !== 'running') {
            await stream.writeSSE({ event: 'end', data: JSON.stringify(summary?.state ?? 'error') });
            return;
          }
          if (Date.now() - lastWrite > STREAM_HEARTBEAT_MS) {
            await stream.write(': sigue\n\n');
            lastWrite = Date.now();
          }
          await stream.sleep(STREAM_POLL_MS);
        }
      });
    });
}

// Segments arrive one by one URI-encoded, as evidenceUrl writes them; a sha
// never changes what it points to.
export function evidenceRoutes() {
  return new Hono<DashboardEnv>().get('/*', async (c) => {
    let parts: string[];
    try {
      // The raw path: each segment is decoded on its own.
      parts = new URL(c.req.url).pathname.slice('/api/evidence/'.length).split('/').map(decodeURIComponent);
    } catch {
      parts = [];
    }
    const [owner, name, sha, ...segments] = parts;
    const entry = (await visibleRepos(c.env.access)).find((repo) => repo.productRepo === `${owner}/${name}`);
    const image = entry && (await readEvidence(entry, sha ?? '', segments));
    if (!image) return c.json({ error: 'no existe esa imagen' }, 404);
    return c.body(new Uint8Array(image.data), 200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
}
