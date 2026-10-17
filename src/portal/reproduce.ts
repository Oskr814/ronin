import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { draftDiff, runOnApp, type AppRun } from '../commands/prototype.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { portalTask } from './prompts.js';
import { insideDir } from '../exploration/index.js';
import { getUser } from './accounts.js';
import { MAX_QUESTIONS } from './classify.js';
import { replyMail } from './mail.js';
import { handOverMail, sendPortalMails } from './notify.js';
import {
  addEvent,
  addRoninMessage,
  errorLine,
  getRequest,
  MAX_REPRODUCTIONS,
  noteEvent,
  prototypePatchPath,
  requestImagePath,
  updateUnlessCancelled,
  type PortalRequest,
  type Reproduction,
  type ReproductionTest,
} from './requests.js';

// A reported error from the portal (#137): on the same app and browsers as
// a prototype (runOnApp), ronin follows the person's steps, writes a test
// that fails because of the error and tries the fix. The images stay with
// the request, behind the person's login; the diff (the test, and the fix
// if it made one) stays on the runner for the team. Then:
//   - reproduced, with a small fix that turned its test green: ronin's,
//     like an approved prototype — the person approves nothing;
//   - reproduced otherwise: the team's, with the steps, the images, the
//     test and the diff;
//   - not reproduced: ronin asks the person what it needs (while it may
//     ask and try again), or it's the team's, saying it could not be
//     reproduced with test data — never closed as "not an error".

// A run that fails twice in a row, or an app that doesn't let the agent
// even try, sends the request to the team: the person is never left
// waiting on a reproduction that won't come.
const ATTEMPTS = 2;

export const FIXING_REPLY = 'Es un error pequeño y ya se está corrigiendo; una persona del equipo revisa el arreglo antes de que salga. Te aviso por correo cuando esté listo.';
export const REPRODUCED_REPLY = 'Se lo envié al equipo de desarrollo con lo que encontré. Te aviso por correo cuando esté resuelto.';
export const NOT_REPRODUCED_REPLY = 'Puede depender de datos que solo están en la aplicación real, así que se lo envié al equipo de desarrollo con tu descripción y lo que intenté. Te aviso por correo cuando esté resuelto.';
export const FAILED_REPRODUCE_REPLY = 'No pude abrir la copia de la aplicación para reproducir el error, así que se lo envié al equipo de desarrollo con tu descripción. Te aviso por correo cuando esté resuelto.';

// The app didn't let the agent even try (its "error"), as opposed to the run
// failing: trying again won't change that.
export class ReproductionDeclined extends Error {}

export interface ReproductionShot {
  // Absolute, inside the run's output dir.
  imagen: string;
  nota?: string;
  kind: 'error' | 'fix';
}

export interface ReproductionOutput {
  reproduced: boolean;
  mensaje: string;
  pregunta?: string;
  steps: string[];
  test?: ReproductionTest;
  fix?: 'small' | 'big';
  reason?: string;
  summary: string;
  shots: ReproductionShot[];
}

const MAX_STEPS = 12;
const MAX_SHOTS = 3;
const MAX_OUTPUT = 3000;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

// The tail of a test's output: where the failure or the summary is.
const tail = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > MAX_OUTPUT ? `…${trimmed.slice(-(MAX_OUTPUT - 1))}` : trimmed;
};

function parseTest(value: unknown): ReproductionTest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const t = value as Record<string, unknown>;
  const name = text(t.nombre, 300);
  if (!name) return undefined;
  const file = text(t.archivo, 300);
  const command = text(t.comando, 500);
  const redOutput = tail(t.salida_rojo);
  const greenOutput = tail(t.salida_verde);
  return {
    kind: t.tipo === 'e2e' ? 'e2e' : 'direct',
    name,
    ...(file ? { file } : {}),
    ...(command ? { command } : {}),
    red: t.rojo === true,
    // Green only counts after red: a test that never failed proves nothing.
    green: t.rojo === true && t.verde === true,
    ...(redOutput ? { redOutput } : {}),
    ...(greenOutput ? { greenOutput } : {}),
  };
}

export function parseReproduction(raw: string, outDir: string): ReproductionOutput | { error: string } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('el resultado no es un objeto JSON');
  const r = parsed as Record<string, unknown>;
  if (typeof r.error === 'string' && r.error.trim()) return { error: r.error.trim().slice(0, 1_000) };
  if (typeof r.reproducido !== 'boolean') throw new Error('el resultado no dice si se reprodujo ("reproducido")');
  const mensaje = text(r.mensaje, 2000);
  if (!mensaje) throw new Error('el resultado no trae "mensaje"');
  const steps = Array.isArray(r.pasos) ? r.pasos.map((s) => text(s, 400)).filter((s): s is string => Boolean(s)).slice(0, MAX_STEPS) : [];
  const shots: ReproductionShot[] = [];
  const count = { error: 0, fix: 0 };
  for (const item of Array.isArray(r.capturas) ? r.capturas : []) {
    if (typeof item !== 'object' || item === null) continue;
    const { imagen, nota, tipo } = item as Record<string, unknown>;
    const path = insideDir(imagen, outDir);
    if (!path || !/\.(png|jpe?g|html?)$/i.test(path)) continue;
    const kind = tipo === 'arreglo' ? 'fix' : 'error';
    if (count[kind]++ >= MAX_SHOTS) continue;
    const caption = text(nota, 200);
    shots.push({ imagen: path, kind, ...(caption ? { nota: caption } : {}) });
  }
  const test = parseTest(r.test);
  const pregunta = r.reproducido ? undefined : text(r.pregunta, 1000);
  const reason = text(r.motivo, 1000);
  const fix = r.arreglo === 'pequeño' ? 'small' : r.arreglo === 'grande' ? 'big' : undefined;
  return {
    reproduced: r.reproducido,
    mensaje,
    ...(pregunta ? { pregunta } : {}),
    steps,
    ...(test ? { test } : {}),
    // A fix needs the error reproduced first.
    ...(fix && r.reproducido ? { fix } : {}),
    ...(reason ? { reason } : {}),
    summary: text(r.resumen, 4000) ?? '',
    shots,
  };
}

// ronin fixes it on its own only with the error reproduced, a small fix,
// its test red without it and green with it, and the diff to start from.
export const fixable = (output: Pick<ReproductionOutput, 'reproduced' | 'fix' | 'test'>, patch: string | undefined) =>
  output.reproduced && output.fix === 'small' && Boolean(output.test?.green) && Boolean(patch);

const testState = (test: ReproductionTest | undefined): 'red' | 'green' | 'none' => (!test?.red ? 'none' : test.green ? 'green' : 'red');

// What the team is told about where it stands.
export function teamReason(output: Pick<ReproductionOutput, 'reproduced' | 'fix' | 'reason' | 'test'>): string {
  if (!output.reproduced) return 'No se pudo reproducir con datos de prueba.';
  const test = output.test?.red ? ', con un test que falla' : ', sin un test que lo pruebe';
  if (output.fix === 'big') return `ronin lo reprodujo${test}; el arreglo es más que un ajuste${output.reason ? `: ${output.reason}` : '.'}`;
  if (output.fix === 'small') return `ronin lo reprodujo${test} y probó un arreglo pequeño${output.test?.green ? ' que lo pasa a verde' : ''}.`;
  return `ronin lo reprodujo${test}, pero no encontró un arreglo claro.`;
}

// Copies the images and the diff into the request, tells the person and
// decides where it goes.
async function deliver(n: number, round: number, output: ReproductionOutput, run: AppRun): Promise<PortalRequest | undefined> {
  const images: string[] = [];
  const captions: string[] = [];
  const count = { error: 0, fix: 0 };
  for (const shot of output.shots) {
    const i = ++count[shot.kind];
    const name = `r${round}-${shot.kind === 'error' ? 'error' : 'arreglo'}-${i}`;
    const image = await run.shot(shot.imagen, name);
    const file = `${name}${extname(image.path).toLowerCase()}`;
    await mkdir(dirname(requestImagePath(n, file)), { recursive: true, mode: 0o700 });
    await copyFile(image.path, requestImagePath(n, file));
    images.push(file);
    captions.push(shot.nota ?? (shot.kind === 'error' ? 'El error' : 'Con el arreglo de prueba'));
  }
  const diff = await draftDiff(run.dir, run.generated);
  let patch: string | undefined;
  if (diff) {
    patch = `r${round}.diff`;
    await mkdir(dirname(prototypePatchPath(n, patch)), { recursive: true, mode: 0o700 });
    await writeFile(prototypePatchPath(n, patch), `${diff}\n`, { mode: 0o600 });
  }
  return updateUnlessCancelled(n, (r) => {
    const at = new Date();
    const ask = !output.reproduced && output.pregunta && r.questions < MAX_QUESTIONS && round < MAX_REPRODUCTIONS;
    const fix = fixable(output, patch);
    const next = ask ? output.pregunta : fix ? FIXING_REPLY : output.reproduced ? REPRODUCED_REPLY : NOT_REPRODUCED_REPLY;
    const messageId = addRoninMessage(r, `${output.mensaje}\n\n${next}`, at, images.length ? { images, captions } : undefined);
    const reproduction: Reproduction = {
      round,
      reproduced: output.reproduced,
      steps: output.steps,
      ...(output.test ? { test: output.test } : {}),
      ...(output.fix ? { fix: output.fix } : {}),
      ...(output.reason ? { reason: output.reason } : {}),
      summary: output.summary,
      ...(patch ? { patch } : {}),
      messageId,
      at: at.toISOString(),
    };
    (r.bug ??= { steps: '', reproductions: [] }).reproductions.push(reproduction);
    addEvent(r, { kind: 'reproduced', round, reproduced: output.reproduced, test: testState(output.test) }, at);
    delete r.worker;
    if (ask) {
      r.status = 'asking';
      r.questions += 1;
      return;
    }
    if (fix) {
      r.status = 'fixing';
      return;
    }
    r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: teamReason(output), at: at.toISOString() };
    addEvent(r, { kind: 'classified', verdict: 'big' }, at);
    r.status = 'big';
  });
}

function reproduce(request: PortalRequest, round: number): Promise<PortalRequest | undefined> {
  const n = request.number;
  return runOnApp(
    {
      key: `portal-r-${n}`,
      appName: request.app,
      task: (base, { compose }) => portalTask({
        type: 'portal-reproduce',
        requestNumber: n,
        ...base,
        compose,
        conversation: request.messages.map((m) => ({ from: m.from, text: m.text, images: m.images.map((file) => requestImagePath(n, file)) })),
        steps: request.bug?.steps ?? '',
        round,
        canAsk: request.questions < MAX_QUESTIONS && round < MAX_REPRODUCTIONS,
      }),
    },
    async (run) => {
      const output = parseReproduction(await readFile(run.outputPath, 'utf8'), run.outDir);
      if ('error' in output) throw new ReproductionDeclined(output.error);
      return deliver(n, round, output, run);
    },
  );
}

// Inside withActiveRepo and the repo's prototype lock, for a request that's
// 'reproducing'. Never throws: one that can't be reproduced goes to the
// team.
export async function reproduceRequest(n: number): Promise<void> {
  const request = await getRequest(n);
  if (!request || request.status !== 'reproducing') return;
  const round = (request.bug?.reproductions.length ?? 0) + 1;
  let failure: Error | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const done = await reproduce(request, round);
      if (!done) {
        log.info(`portal: el pedido P-${n} se canceló mientras se reproducía su error`);
        return;
      }
      log.info(`portal: reproducción ${round} del pedido P-${n} → ${done.status}`);
      const user = await getUser(done.userId);
      if (done.status === 'big') await handOverMail(done, user);
      else if (user) await sendPortalMails(done, [replyMail(done, user, config.portal.url)]);
      return;
    } catch (error) {
      failure = error as Error;
      log.error(`portal: falló la reproducción ${round} del pedido P-${n} (intento ${attempt} de ${ATTEMPTS})`, error);
      await noteEvent(n, { kind: 'failed', step: 'reproduce', error: errorLine(error) });
      if (error instanceof ReproductionDeclined) break;
    }
  }
  try {
    const handed = await updateUnlessCancelled(n, (r) => {
      r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: `No se pudo reproducir: ${failure ? errorLine(failure) : 'sin detalle'}`, at: new Date().toISOString() };
      addRoninMessage(r, FAILED_REPRODUCE_REPLY);
      addEvent(r, { kind: 'classified', verdict: 'big' });
      r.status = 'big';
      delete r.worker;
    });
    if (handed) await handOverMail(handed, await getUser(handed.userId));
  } catch (error) {
    log.error(`portal: no se pudo pasar al equipo el pedido P-${n}`, error);
  }
}
