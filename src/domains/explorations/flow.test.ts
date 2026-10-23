import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let base = '';
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', worktreeBasePath: base }) }));
vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent', worktreeBaseRef: 'origin/main', exploreTimezone: 'America/Tegucigalpa' } }));
vi.mock('@platform/github/github.js', () => ({}));
vi.mock('@platform/agents/agent-task.js', () => ({}));
vi.mock('../product-app/runtime.js', () => ({}));
vi.mock('./run.js', () => ({}));
vi.mock('./inventory.js', () => ({ explorationOutDir: () => base }));

import { acquireExploreLock, explorationDay, exploreWorkerBusy, issueRequest, releaseExploreLock, renderOriginReply, renderRunReply, type PublishedRun } from './flow.js';

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

  it('says what was explored, what it proposes, and that issues wait for the approval', () => {
    const reply = renderRunReply('backoffice', run([{ id: 'F-0001', titulo: 'Doble toque', gravedad: 'bug' }]));
    expect(reply).toContain('`pedidos.confirmar` (interrupciones); fallaron `pedidos.surtir`');
    expect(reply).toContain('- **F-0001** Doble toque — `bug`\n');
    expect(reply).not.toContain('issue #');
    expect(reply).toContain('#820. Revisalas ahí: al aprobarlo abro un issue por cada una que siga en pie.');
  });

  it('is honest when nothing made it', () => {
    expect(renderRunReply('backoffice', run([], 3))).toContain('No encontré nada que valga la pena proponer (descarté 3 candidato(s)');
  });

  it('says it followed the issue, or why it explored nothing', () => {
    const focused = run([]);
    focused.summary.focus = { text: 'x', issue: 31 };
    expect(renderRunReply('backoffice', focused)).toContain('Exploré `backoffice` con foco en lo que pide este issue:');
    focused.summary.unfocused = 'el pedido es de otra app';
    expect(renderRunReply('backoffice', focused)).toBe('No exploré `backoffice`: el pedido es de otra app. Si el pedido es de otra app, pedímelo con esa; si es de esta, contame en qué pantalla está y volvé a pedirlo.');
  });
});

describe('issueRequest', () => {
  const comment = (author: string, body: string, id = 1) => ({ author, body, createdAt: '', url: `https://github.com/acme/x/issues/3#issuecomment-${id}` });

  it('is the title, the body and what people said, without the commands to ronin or bots', () => {
    const text = issueRequest({
      title: 'Los formularios ocupan mucho',
      body: 'En el teléfono hay que hacer scroll todo el rato.',
      comments: [
        comment('linear[bot]', 'DEV-1'),
        comment('persona', 'Sobre todo los numéricos.'),
        comment('ronin-agent', 'Exploré...'),
        comment('persona', '@ronin-agent /explore webapp 4 y mirá el rango también', 9),
      ],
    });
    expect(text).toBe('# Los formularios ocupan mucho\n\nEn el teléfono hay que hacer scroll todo el rato.\n\nSobre todo los numéricos.\n\ny mirá el rango también');
  });

  it('is nothing when the issue only has a title and the command: that run goes as at night', () => {
    expect(issueRequest({ title: 'Explorar', body: '  ', comments: [comment('persona', '@ronin-agent /explore webapp')] })).toBeUndefined();
  });
});

describe('renderOriginReply', () => {
  it('lists what stood with its issue', () => {
    expect(renderOriginReply(840, [{ id: 'F-0002', titulo: 'Signos en una fila', issue: 77 }, { id: 'F-0003', titulo: 'Sin issue' }]))
      .toBe('Se aprobó el PR de exploración #840. De lo que se pidió acá quedaron en pie estas propuestas, cada una con su issue:\n\n- #77 Signos en una fila\n- F-0003 Sin issue');
  });
});

describe('explorationDay', () => {
  it('dates a run in the exploration zone: 02:00 UTC Monday is still Sunday in Tegucigalpa', () => {
    expect(explorationDay(new Date('2026-10-19T02:00:00Z'))).toBe('2026-10-18');
  });
});
