import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('./repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
vi.mock('./config.js', () => ({ config: { githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main', exploreTimezone: 'America/Tegucigalpa' } }));
vi.mock('./github.js', () => ({}));
vi.mock('./agent-task.js', () => ({}));
vi.mock('./app-runtime.js', () => ({}));
vi.mock('./exploration-run.js', () => ({}));
vi.mock('./exploration-inventory.js', () => ({ explorationOutDir: () => base }));

import { acquireExploreLock, explorationDay, exploreWorkerBusy, releaseExploreLock, renderRunReply, type PublishedRun } from './exploration-flow.js';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ronin-flow-'));
  return () => rm(base, { recursive: true, force: true });
});

describe('explore lock', () => {
  it('is exclusive while its holder lives, and free once released', async () => {
    expect(await exploreWorkerBusy()).toBe(false);
    expect(await acquireExploreLock()).toBe(true);
    expect(await exploreWorkerBusy()).toBe(true);
    expect(await acquireExploreLock()).toBe(false);
    await releaseExploreLock();
    expect(await exploreWorkerBusy()).toBe(false);
  });

  it('takes over a lock left by a process that died', async () => {
    await writeFile(join(base, '.explore-redmotos-shoppingcart.lock'), '999999999');
    expect(await exploreWorkerBusy()).toBe(false);
    expect(await acquireExploreLock()).toBe(true);
    await releaseExploreLock();
  });
});

describe('renderRunReply', () => {
  const run = (findings: unknown[], discarded = 0): PublishedRun => ({
    prNumber: 820,
    batch: '2026-10-12',
    urgentIssues: [{ id: 'F-0001', issue: 821 }],
    summary: {
      runId: '2026-10-12-7', seed: 7, plan: { seed: 7, functions: [] }, runFile: '/r.md', inventory: { added: [], retired: [], refreshed: false },
      outcomes: [
        { planned: { functionId: 'pedidos.confirmar', charter: 'interrupciones', role: 'Sales', reason: 'nueva' }, status: 'explorada', tareas: [] },
        { planned: { functionId: 'pedidos.surtir', charter: 'volumen', role: 'Sales', reason: 'azar' }, status: 'fallo', tareas: [], error: 'x' },
      ],
      findings: findings as any,
      discarded: Array.from({ length: discarded }, () => ({ titulo: 't', funcion: 'f', motivo: 'm' })),
    },
  });

  it('says what was explored, what it proposes with links, and where to review', () => {
    const reply = renderRunReply('backoffice', run([{ id: 'F-0001', titulo: 'Doble toque', gravedad: 'bug' }]));
    expect(reply).toContain('`pedidos.confirmar` (interrupciones); fallaron `pedidos.surtir`');
    expect(reply).toContain('**F-0001** Doble toque — `bug` · issue #821');
    expect(reply).toContain('#820');
  });

  it('is honest when nothing made it', () => {
    expect(renderRunReply('backoffice', run([], 3))).toContain('No encontré nada que valga la pena proponer (descarté 3 candidato(s)');
  });
});

describe('explorationDay', () => {
  it('dates a run in the exploration zone: 02:00 UTC Monday is still Sunday in Tegucigalpa', () => {
    expect(explorationDay(new Date('2026-10-19T02:00:00Z'))).toBe('2026-10-18');
  });
});
