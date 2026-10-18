import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishRunRecord, listRunRecords, startRunRecord } from './run-log.js';

const summary = {
  runId: '2026-10-18-559417',
  seed: 559417,
  plan: { seed: 559417, functions: [] },
  outcomes: [
    { planned: { functionId: 'surtir', charter: 'interrupciones', role: 'Sales', reason: 'nueva' }, status: 'explorada', tareas: [{ viewport: 'mobile', tarea: 'x', completada: true, pasos: 3 }, { viewport: 'mobile', tarea: 'y', completada: false, pasos: 2 }] },
    { planned: { functionId: 'clientes', charter: 'datos-hostiles', role: 'Sales', reason: 'azar' }, status: 'fallo', tareas: [], error: 'el navegador no abrió\nstack' },
  ],
  findings: [{ id: 'F-0021', titulo: 'Recargar pierde lo marcado', tipo: 'hallazgo', gravedad: 'bug' }],
  discarded: [{ titulo: 'a', funcion: 'surtir', motivo: 'b' }],
  runFile: '',
  inventory: { added: ['cotizaciones'], retired: [], refreshed: true },
} as any;

beforeEach(async () => {
  process.env.RONIN_LOGS_DIR = await mkdtemp(join(tmpdir(), 'run-log-'));
});

describe('run records', () => {
  it('is written when the run starts and closed with what it explored', async () => {
    const record = await startRunRecord({ repo: 'acme/shop', app: 'backoffice', trigger: { kind: 'noche' }, maxFunctions: 3, until: '2026-10-19T12:00:00.000Z' }, new Date('2026-10-19T07:01:00Z'));
    expect(record).toMatchObject({ id: '20261019T070100-backoffice', state: 'running', maxFunctions: 3 });
    expect(await listRunRecords('acme/shop', 'backoffice')).toEqual([record]);

    await finishRunRecord(record, { summary, prNumber: 919 }, new Date('2026-10-19T07:49:00Z'));
    const [done] = await listRunRecords('acme/shop', 'backoffice');
    expect(done).toMatchObject({
      state: 'ok', endedAt: '2026-10-19T07:49:00.000Z', runId: '2026-10-18-559417', seed: 559417, prNumber: 919, discarded: 1,
      functions: [
        { id: 'surtir', charter: 'interrupciones', role: 'Sales', reason: 'nueva', status: 'explorada', viewports: ['mobile'] },
        { id: 'clientes', charter: 'datos-hostiles', status: 'fallo', viewports: [], error: 'el navegador no abrió' },
      ],
      findings: [{ id: 'F-0021', titulo: 'Recargar pierde lo marcado', tipo: 'hallazgo', gravedad: 'bug' }],
      inventory: { added: ['cotizaciones'], retired: [] },
    });
    // No temporary file left behind.
    expect(await readdir(join(process.env.RONIN_LOGS_DIR!, 'exploration', 'acme-shop'))).toEqual(['20261019T070100-backoffice.json']);
  });

  it('keeps the first line of the error of a run that failed', async () => {
    const record = await startRunRecord({ repo: 'acme/shop', app: 'backoffice', trigger: { kind: 'issue', issueNumber: 12 } });
    await finishRunRecord(record, { error: new Error('app:up falló\nmás detalle') });
    const [done] = await listRunRecords('acme/shop', 'backoffice');
    expect(done).toMatchObject({ state: 'error', error: 'app:up falló', trigger: { kind: 'issue', issueNumber: 12 } });
  });

  it('lists only the app’s runs, newest first', async () => {
    await startRunRecord({ repo: 'acme/shop', app: 'backoffice', trigger: { kind: 'noche' } }, new Date('2026-10-17T07:00:00Z'));
    await startRunRecord({ repo: 'acme/shop', app: 'b-office', trigger: { kind: 'noche' } }, new Date('2026-10-18T07:00:00Z'));
    await startRunRecord({ repo: 'acme/shop', app: 'backoffice', trigger: { kind: 'manual' } }, new Date('2026-10-18T15:00:00Z'));
    expect((await listRunRecords('acme/shop', 'backoffice')).map((r) => r.startedAt)).toEqual(['2026-10-18T15:00:00.000Z', '2026-10-17T07:00:00.000Z']);
    expect(await listRunRecords('acme/shop', 'office')).toEqual([]);
    expect(await listRunRecords('acme/other', 'backoffice')).toEqual([]);
  });
});
