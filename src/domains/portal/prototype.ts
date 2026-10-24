import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { makePrototype, PrototypeDeclined, stagedConversation, type PrototypeDraft } from './app-run.js';
import { config } from '@platform/config/config.js';
import { log } from '@platform/logger.js';
import { host } from '@platform/host/host.js';
import { portalTask } from './prompts.js';
import { getUser } from './accounts.js';
import { prototypeMail } from './mail.js';
import { launchPortalWorker } from './launch.js';
import { decideHint } from './classify.js';
import { awaitingDevMail, handOverMail, sendPortalMails } from './notify.js';
import {
  addEvent,
  addPersonNote,
  errorLine,
  noteEvent,
  addRoninMessage,
  getRequest,
  prototypePatchPath,
  proposalRounds,
  requestImagePath,
  RequestError,
  updateRequest,
  updateUnlessClosed,
  type PortalRequest,
  type Priority,
} from './requests.js';

// The prototype of a small change asked in the portal (#114), made on the
// running app (app-run.ts's makePrototype). The images stay with the
// request, behind the person's login, and the diff stays on the runner for
// the team. Then the person approves it, asks for an adjustment
// (a new message, read again by classify.ts) or turns it down.

// A run that fails twice in a row, or an agent that finds no prototype to
// make, sends the request to the team: the person is never left waiting on
// a prototype that won't come.
const ATTEMPTS = 2;

// `round`: the proposals the person saw, this one included (#409).
export function proposedReply(mensaje: string | undefined, round: number): string {
  return `${mensaje ?? 'Así quedaría el cambio.'}\n\n${decideHint(round)}`;
}

export const APPROVED_REPLY = '¡Quedó aprobado! Ahora el equipo de desarrollo revisa tu pedido antes de que haga el cambio. Te aviso por correo cuando esté listo para la próxima actualización.';
export const APPROVED_PRIORITY_REPLY = '¡Quedó aprobado como prioritario! El equipo de desarrollo lo ve antes que los demás y ya le avisé por correo. Lo revisan antes de que haga el cambio, y te aviso cuando esté listo para la próxima actualización.';
export const REJECTED_REPLY = 'Entendido. Se lo paso al equipo de desarrollo con tu pedido y lo que conversamos. Te aviso por correo cuando esté resuelto.';
export const FAILED_PROTOTYPE_REPLY = 'No pude armar el prototipo de este cambio, así que se lo paso al equipo de desarrollo con tu pedido y lo que conversamos. Te aviso por correo cuando esté resuelto.';

// The pairs worth showing (#409), by their index: not one whose before and
// after are the same image (nothing changes there), nor the same pair
// again. Never none: when all are alike, the first stays.
export async function distinctPairs(draft: PrototypeDraft): Promise<number[]> {
  const digest = (shot: PrototypeDraft['antes'][number] | undefined) => (shot
    ? host().fs.readFile(shot.path).then((data) => createHash('sha256').update(data).digest('hex'), () => shot.path)
    : Promise.resolve(''));
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let i = 0; i < Math.max(draft.antes.length, draft.despues.length); i++) {
    const [before, after] = await Promise.all([digest(draft.antes[i]), digest(draft.despues[i])]);
    if (before && before === after) continue;
    if (seen.has(`${before} ${after}`)) continue;
    seen.add(`${before} ${after}`);
    keep.push(i);
  }
  return keep.length ? keep : [0];
}

// Befores and afters side by side: antes-1, después-1, antes-2…, numbered
// by the pairs kept.
function pairs(draft: PrototypeDraft, keep: number[]): Array<{ kind: 'antes' | 'despues'; i: number; path: string; caption: string }> {
  const out = [];
  for (const [i, at] of keep.entries()) {
    for (const kind of ['antes', 'despues'] as const) {
      const shot = draft[kind][at];
      if (shot) out.push({ kind, i, path: shot.path, caption: `${kind === 'antes' ? 'Antes' : 'Después'}${shot.nota ? `: ${shot.nota}` : ''}` });
    }
  }
  return out;
}

// Copies the images and the diff into the request and shows them.
async function deliver(n: number, round: number, draft: PrototypeDraft): Promise<PortalRequest | undefined> {
  const images: string[] = [];
  const captions: string[] = [];
  const keep = await distinctPairs(draft);
  const total = Math.max(draft.antes.length, draft.despues.length);
  if (keep.length < total) log.info(`portal: el prototipo ${round} del pedido P-${n} trae ${total - keep.length} ${total - keep.length === 1 ? 'par repetido o sin cambios' : 'pares repetidos o sin cambios'}: no se muestran`);
  for (const shot of pairs(draft, keep)) {
    const file = `p${round}-${shot.kind}-${shot.i + 1}${extname(shot.path).toLowerCase()}`;
    await mkdir(dirname(requestImagePath(n, file)), { recursive: true, mode: 0o700 });
    // From the host, where the run left it, to the request's own data.
    await writeFile(requestImagePath(n, file), await host().fs.readFile(shot.path));
    images.push(file);
    captions.push(shot.caption);
  }
  let patch: string | undefined;
  if (draft.patch) {
    patch = `${round}.diff`;
    await mkdir(dirname(prototypePatchPath(n, patch)), { recursive: true, mode: 0o700 });
    await writeFile(prototypePatchPath(n, patch), `${draft.patch}\n`, { mode: 0o600 });
  }
  return updateUnlessClosed(n, (r) => {
    const at = new Date();
    const messageId = addRoninMessage(r, proposedReply(draft.mensaje, proposalRounds(r) + 1), at, { images, captions });
    (r.prototypes ??= []).push({ round, summary: draft.resumen, ...(draft.team ? { team: draft.team } : {}), ...(patch ? { patch } : {}), messageId, at: at.toISOString() });
    r.status = 'proposed';
    delete r.worker;
  });
}

function draw(request: PortalRequest, round: number): Promise<PortalRequest | undefined> {
  const n = request.number;
  return makePrototype(
    {
      key: `portal-p-${n}`,
      appName: request.app,
      task: async (base, { stage }) => portalTask({
        type: 'portal-prototype',
        requestNumber: n,
        ...base,
        conversation: await stagedConversation(request, stage),
        instruction: request.verdict?.instruction ?? '',
        ...(request.verdict?.findings ? { findings: request.verdict.findings } : {}),
        round,
      }),
    },
    (draft) => deliver(n, round, draft),
  );
}

// Inside withActiveRepo and the repo's prototype lock, for a request that's
// 'minor'. Never throws: a prototype that can't be made goes to the team.
export async function prototypeRequest(n: number): Promise<void> {
  const request = await getRequest(n);
  if (!request || request.status !== 'minor') return;
  const round = (request.prototypes?.length ?? 0) + 1;
  let failure: Error | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const shown = await draw(request, round);
      if (!shown) {
        log.info(`portal: el pedido P-${n} se cerró mientras se armaba su prototipo`);
        return;
      }
      log.info(`portal: prototipo ${round} del pedido P-${n} listo`);
      const user = await getUser(shown.userId);
      if (user) await sendPortalMails(shown, [prototypeMail(shown, user, config.portal.url)]);
      return;
    } catch (error) {
      failure = error as Error;
      log.error(`portal: falló el prototipo ${round} del pedido P-${n} (intento ${attempt} de ${ATTEMPTS})`, error);
      await noteEvent(n, { kind: 'failed', step: 'prototype', error: errorLine(error) });
      if (error instanceof PrototypeDeclined) break;
    }
  }
  try {
    const handed = await updateUnlessClosed(n, (r) => {
      r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: `No se pudo armar el prototipo: ${failure?.message.split('\n')[0].slice(0, 300) ?? 'sin detalle'}`, at: new Date().toISOString() };
      addRoninMessage(r, FAILED_PROTOTYPE_REPLY);
      addEvent(r, { kind: 'classified', verdict: 'big' });
      r.status = 'big';
      delete r.worker;
    });
    if (handed) await handOverMail(handed, await getUser(handed.userId));
  } catch (error) {
    log.error(`portal: no se pudo pasar al equipo el pedido P-${n}`, error);
  }
}

export type Decision = 'aprobar' | 'rechazar';

// What the person decided on the prototype on screen. Either way the worker
// opens its issue (issue.ts): approved, for ronin to make; turned down, for
// the team to look at, like a big one.
// Approving it, the person may mark it prioritario (priority.ts): the route
// already checked their day's limit.
export async function decideRequest(n: number, decision: Decision, note = '', launch = launchPortalWorker, priority?: Omit<Priority, 'at'>): Promise<PortalRequest> {
  const decided = await updateRequest(n, (r) => {
    if (r.status !== 'proposed') throw new RequestError('Este pedido no espera tu decisión ahora.');
    const at = new Date();
    r.decision = { kind: decision === 'aprobar' ? 'approved' : 'rejected', at: at.toISOString() };
    addEvent(r, { kind: 'decided', decision: r.decision.kind }, at);
    if (decision === 'aprobar') {
      // A dev decides before ronin makes it (#353, dev-decision.ts).
      r.status = 'awaiting-dev';
      if (priority) {
        r.priority = { ...priority, at: at.toISOString() };
        addEvent(r, { kind: 'priority', impact: priority.impact }, at);
      }
      addRoninMessage(r, priority ? APPROVED_PRIORITY_REPLY : APPROVED_REPLY, at);
    } else {
      if (note.trim()) addPersonNote(r, note.trim(), at);
      r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: r.verdict?.prototype === false ? 'La persona no aprobó la propuesta.' : 'La persona no aprobó el prototipo.', at: at.toISOString() };
      r.status = 'big';
      addRoninMessage(r, REJECTED_REPLY, at);
    }
    return r;
  });
  log.info(`portal: el pedido P-${n} quedó ${decision === 'aprobar' ? (priority ? 'aprobado como prioritario' : 'aprobado') : 'para el equipo (prototipo no aprobado)'}`);
  if (decided.status === 'big') {
    await handOverMail(decided, await getUser(decided.userId));
    await launch(n);
  } else await awaitingDevMail(decided, await getUser(decided.userId));
  return decided;
}
