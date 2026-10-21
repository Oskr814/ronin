import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('../../platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'acme/product', worktreeBasePath: base }) }));
vi.mock('../../platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent' } }));

const { listPreviewStates } = await import('./preview.js');

async function preview(pr: number, state: Record<string, unknown>) {
  const dir = join(base, `preview-pr-${pr}`, '.ronin-app');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'preview.json'), JSON.stringify({ prNumber: pr, appName: 'webapp', sha: 'abc', url: `https://h:2000${pr % 10}`, ...state }));
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-preview-states-'));
  await preview(408, { preparing: true });
  // Its worker is this very process: alive.
  await writeFile(join(base, '.preview-pr-408.lock'), String(process.pid));
  await preview(409, { preparing: true });
  // A worker that died while preparing.
  await writeFile(join(base, '.preview-pr-409.lock'), '999999999');
  await preview(410, {});
});

describe('listPreviewStates', () => {
  it('says a preview is still preparing its data only while its worker lives', async () => {
    const states = Object.fromEntries((await listPreviewStates()).map((s) => [s.prNumber, s.preparing ?? false]));
    expect(states).toEqual({ 408: true, 409: false, 410: false });
  });
});
