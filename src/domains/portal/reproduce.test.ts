import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@platform/config/config.js';
import type { AppRun, PrototypeTarget } from './app-run.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, MAX_REPRODUCTIONS, prototypePatchPath, requestImagePath, updateRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));
const runOnApp = vi.fn();
const draftDiff = vi.fn(async () => 'diff --git a/T.cs b/T.cs\n+[Fact]');
vi.mock('./app-run.js', async (original) => ({
  ...(await original<typeof import('./app-run.js')>()),
  runOnApp: (...args: unknown[]) => runOnApp(...args),
  draftDiff: () => draftDiff(),
}));

const { FAILED_REPRODUCE_REPLY, FIXING_REPLY, NOT_REPRODUCED_REPLY, parseReproduction, REPRODUCED_REPLY, reproduceRequest, ReproductionDeclined } = await import('./reproduce.js');

const outDir = mkdtempSync(join(tmpdir(), 'ronin-portal-repro-'));
mkdirSync(join(outDir, 'sales-desktop'));
for (const name of ['error-1.png', 'arreglo-1.png']) writeFileSync(join(outDir, 'sales-desktop', name), name);
const run: AppRun = {
  appName: 'backoffice', dir: '/w', outDir, outputPath: join(outDir, 'result.json'), generated: [], diff: () => draftDiff(),
  shot: async (path) => ({ path, viewport: 'desktop' }), script: async () => undefined,
};

const reproduced = {
  reproducido: true,
  mensaje: 'Lo pude reproducir: al filtrar hasta una fecha quedan fuera los pedidos de ese día.',
  pasos: ['Creó 3 pedidos del 16/10', 'Filtró hasta 16/10', 'Faltan los del 16'],
  test: { tipo: 'directo', nombre: 'FilterByDateRange_IncluyeLosPedidosDelDiaFinal', archivo: 'apps/api/T.cs', comando: 'dotnet test', rojo: true, verde: true, salida_rojo: 'Failed: 1', salida_verde: 'Passed: 15' },
  arreglo: 'pequeño',
  resumen: 'FilterByDateRange compara con la medianoche del día final.',
  capturas: [{ imagen: 'sales-desktop/error-1.png', nota: 'Hasta el 16, sin los del 16', tipo: 'error' }, { imagen: 'sales-desktop/arreglo-1.png', tipo: 'arreglo' }],
};
const notReproduced = { reproducido: false, mensaje: 'Intenté que pasara, pero ahí el filtro sí muestra los pedidos del día.', pregunta: '¿Me dices el número de un pedido que no te aparece?', pasos: ['Filtró hasta 16/10: aparecen'], resumen: 'Quizás el pedido viene de Odoo con otra hora.' };

const app = { exec: vi.fn() };
const extra = { app, stage: async (path: string) => `/out/request/${path.split('/').pop()}` };

// The agent "writes" `result` and the supervisor reads it, as in the real run.
function agentWrites(result: unknown, check?: (target: PrototypeTarget) => void | Promise<void>) {
  runOnApp.mockImplementation(async (target: PrototypeTarget, collect: (r: AppRun) => Promise<unknown>) => {
    await check?.(target);
    writeFileSync(run.outputPath, JSON.stringify(result));
    return collect(run);
  });
}

async function errorRequest(over: { questions?: number; tries?: number } = {}) {
  const user = await createUser({ email: 'km@x.com', name: 'Karla Mejía', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'Filtro hasta hoy y no me salen los de hoy', images: [] });
  await updateRequest(r.number, (x) => {
    x.status = 'reproducing';
    x.questions = over.questions ?? 0;
    x.verdict = { kind: 'error', summary: 'OrderHeaderExtensions', at: '' };
    x.bug = { steps: 'Sales, Gestionar Pedidos, hasta 16/10', reproductions: Array.from({ length: over.tries ?? 0 }, (_, i) => ({ round: i + 1, reproduced: false, steps: [], summary: '', messageId: 1, at: '' })) };
  });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
  runOnApp.mockReset();
});

describe('parseReproduction', () => {
  it('keeps the test, the fix and the images inside the run, and a green only after a red', () => {
    const out = parseReproduction(JSON.stringify({ ...reproduced, capturas: [...reproduced.capturas, { imagen: '../../etc/passwd.png', tipo: 'error' }] }), outDir);
    expect(out).toMatchObject({
      reproduced: true, fix: 'small', steps: reproduced.pasos, summary: reproduced.resumen,
      test: { kind: 'direct', name: 'FilterByDateRange_IncluyeLosPedidosDelDiaFinal', red: true, green: true, redOutput: 'Failed: 1' },
      shots: [{ kind: 'error', nota: 'Hasta el 16, sin los del 16' }, { kind: 'fix' }],
    });
    expect('shots' in out && out.shots).toHaveLength(2);
    const neverRed = parseReproduction(JSON.stringify({ ...reproduced, test: { ...reproduced.test, rojo: false } }), outDir);
    expect('test' in neverRed && neverRed.test).toMatchObject({ red: false, green: false });
  });

  it('a fix needs the error reproduced, and only an unreproduced one asks', () => {
    const out = parseReproduction(JSON.stringify({ ...notReproduced, arreglo: 'pequeño' }), outDir);
    expect(out).toMatchObject({ reproduced: false, pregunta: notReproduced.pregunta });
    expect('fix' in out).toBe(false);
    expect(parseReproduction(JSON.stringify({ ...reproduced, pregunta: '¿Algo?' }), outDir)).not.toHaveProperty('pregunta');
  });

  it("refuses a result that doesn't say whether it was reproduced, and passes on the app's refusal", () => {
    expect(() => parseReproduction(JSON.stringify({ mensaje: 'x' }), outDir)).toThrow(/reproducido/);
    expect(parseReproduction(JSON.stringify({ error: 'La pantalla no existe' }), outDir)).toEqual({ error: 'La pantalla no existe' });
  });
});

describe('reproduceRequest', () => {
  it('reproduced with a small fix that turned its test green: it waits for a dev to decide (#353), the person approves nothing', async () => {
    const n = await errorRequest();
    agentWrites(reproduced, async (target) => {
      expect(target).toMatchObject({ key: `portal-r-${n}`, appName: 'backoffice' });
      expect(await target.task({} as never, extra)).toMatchObject({ type: 'portal-reproduce', requestNumber: n, app, steps: 'Sales, Gestionar Pedidos, hasta 16/10', round: 1, canAsk: true });
    });
    await reproduceRequest(n);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'awaiting-dev', verdict: { kind: 'error', summary: 'OrderHeaderExtensions' } });
    expect(r.worker).toBeUndefined();
    const shown = r.messages.at(-1)!;
    expect(shown).toMatchObject({ from: 'ronin', text: `${reproduced.mensaje}\n\n${FIXING_REPLY}`, images: ['r1-error-1.png', 'r1-arreglo-1.png'], captions: ['Hasta el 16, sin los del 16', 'Con el arreglo de prueba'] });
    expect(await readFile(requestImagePath(n, 'r1-error-1.png'), 'utf8')).toBe('error-1.png');
    expect(r.bug?.reproductions).toEqual([expect.objectContaining({ round: 1, reproduced: true, fix: 'small', patch: 'r1.diff', messageId: shown.id, test: expect.objectContaining({ green: true }) })]);
    expect(await readFile(prototypePatchPath(n, 'r1.diff'), 'utf8')).toContain('+[Fact]');
    expect(r.events?.map((e) => e.kind)).toEqual(['reproduced', 'mail', 'mail']);
    expect(r.events?.[0]).toMatchObject({ round: 1, reproduced: true, test: 'green' });
    // The person hears it; the team, that it waits for their decision.
    expect(sendMail.mock.calls.map((c) => (c as unknown as [{ to: string; subject: string }])[0])).toEqual([
      expect.objectContaining({ to: 'km@x.com', subject: expect.stringMatching(/^ronin te respondió/) }),
      expect.objectContaining({ subject: expect.stringMatching(/para decidir/), text: expect.stringContaining('un arreglo chico lo pasó a verde') }),
    ]);
  });

  it('reproduced otherwise — a big fix, a test that never went green, or no diff: the team’s, with what it found', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...reproduced, arreglo: 'grande', motivo: 'Hay que migrar las fechas' }, /el arreglo es más que un ajuste: Hay que migrar las fechas/],
      [{ ...reproduced, test: { ...reproduced.test, verde: false } }, /probó un arreglo pequeño\.$/],
      [{ ...reproduced, test: undefined }, /sin un test que lo pruebe/],
    ];
    for (const [result, reason] of cases) {
      await rm(config.portal.dataDir, { recursive: true, force: true });
      sendMail.mockClear();
      const n = await errorRequest();
      agentWrites(result);
      await reproduceRequest(n);
      const r = (await getRequest(n))!;
      expect(r).toMatchObject({ status: 'big', verdict: { kind: 'big', summary: 'OrderHeaderExtensions' } });
      expect(r.verdict?.reason).toMatch(reason);
      expect(r.messages.at(-1)?.text).toBe(`${reproduced.mensaje}\n\n${REPRODUCED_REPLY}`);
      expect(r.events?.map((e) => e.kind)).toEqual(['reproduced', 'classified', 'mail']);
      // The person hears now; the team, once the worker opened its issue.
      expect(sendMail.mock.calls.map((c) => (c as unknown as [{ subject: string }])[0].subject)).toEqual([expect.stringMatching(/^Recibimos tu pedido/)]);
    }
    await rm(config.portal.dataDir, { recursive: true, force: true });
    const n = await errorRequest();
    draftDiff.mockResolvedValueOnce('');
    agentWrites(reproduced);
    await reproduceRequest(n);
    expect((await getRequest(n))?.status).toBe('big');
  });

  it('not reproduced: asks the person what it needs, and counts the question', async () => {
    const n = await errorRequest();
    agentWrites(notReproduced);
    await reproduceRequest(n);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'asking', questions: 1, bug: { reproductions: [{ reproduced: false, summary: notReproduced.resumen }] } });
    expect(r.messages.at(-1)?.text).toBe(`${notReproduced.mensaje}\n\n${notReproduced.pregunta}`);
    expect(r.events?.[0]).toMatchObject({ kind: 'reproduced', reproduced: false, test: 'none' });
    expect(sendMail.mock.calls[0]).toMatchObject([{ to: 'km@x.com', subject: expect.stringMatching(/^ronin te hizo una pregunta/) }, expect.any(String)]);
  });

  it('not reproduced on its last try, or out of questions: the team’s, never closed', async () => {
    for (const over of [{ tries: MAX_REPRODUCTIONS - 1 }, { questions: 3 }]) {
      await rm(config.portal.dataDir, { recursive: true, force: true });
      const n = await errorRequest(over);
      agentWrites(notReproduced, async (target) => expect(await target.task({} as never, extra)).toMatchObject({ canAsk: false }));
      await reproduceRequest(n);
      const r = (await getRequest(n))!;
      expect(r).toMatchObject({ status: 'big', verdict: { reason: 'No se pudo reproducir con datos de prueba.' } });
      expect(r.messages.at(-1)?.text).toBe(`${notReproduced.mensaje}\n\n${NOT_REPRODUCED_REPLY}`);
    }
  });

  it('tries twice, then hands it to the team; an app that does not let it try, once', async () => {
    const n = await errorRequest();
    runOnApp.mockRejectedValue(new Error('docker compose up falló'));
    await reproduceRequest(n);
    expect(runOnApp).toHaveBeenCalledTimes(2);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'big', verdict: { reason: 'No se pudo reproducir: docker compose up falló' } });
    expect(r.messages.at(-1)?.text).toBe(FAILED_REPRODUCE_REPLY);
    expect(r.events?.map((e) => e.kind)).toEqual(['failed', 'failed', 'classified', 'mail']);
    expect(r.events?.[0]).toMatchObject({ step: 'reproduce' });

    await rm(config.portal.dataDir, { recursive: true, force: true });
    runOnApp.mockReset();
    const m = await errorRequest();
    runOnApp.mockRejectedValue(new ReproductionDeclined('La pantalla no existe'));
    await reproduceRequest(m);
    expect(runOnApp).toHaveBeenCalledOnce();
    expect((await getRequest(m))?.status).toBe('big');
  });

  it('cancelled while it was being reproduced, it is left cancelled and nobody is told', async () => {
    const n = await errorRequest();
    runOnApp.mockImplementation(async (_t: PrototypeTarget, collect: (r: AppRun) => Promise<unknown>) => {
      await updateRequest(n, (x) => { x.status = 'cancelled'; });
      writeFileSync(run.outputPath, JSON.stringify(reproduced));
      return collect(run);
    });
    await reproduceRequest(n);
    expect((await getRequest(n))).toMatchObject({ status: 'cancelled', bug: { reproductions: [] } });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
