import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { makePrototype, PrototypeDeclined, type PrototypeDraft } from '../commands/prototype.js';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';
import { getUser } from './accounts.js';
import { prototypeMail } from './mail.js';
import { handOverMails, sendPortalMails, teamMail } from './notify.js';
import {
  addPersonNote,
  addRoninMessage,
  getRequest,
  MAX_PROTOTYPES,
  prototypePatchPath,
  requestImagePath,
  RequestError,
  updateRequest,
  type PortalRequest,
} from './requests.js';

// The prototype of a small change asked in the portal (#114): the same run
// as an issue's /prototype (commands/prototype.ts), but the images stay
// with the request, behind the person's login, and the diff stays on the
// runner for the team. Then the person approves it, asks for an adjustment
// (a new message, read again by classify.ts) or turns it down.

// A run that fails twice in a row, or an agent that finds no prototype to
// make, sends the request to the team: the person is never left waiting on
// a prototype that won't come.
const ATTEMPTS = 2;

export function proposedReply(mensaje: string | undefined, round: number): string {
  const left = MAX_PROTOTYPES - round;
  const next = left > 0
    ? `Si te gusta, apruébalo. Si quieres cambiar algo, escríbeme qué (${left === 1 ? 'queda 1 ajuste' : `quedan ${left} ajustes`}). Si no es lo que buscabas, elige «No me sirve» y se lo paso al equipo.`
    : 'Este es el último ajuste que puedo hacer aquí: si te gusta, apruébalo; si no, elige «No me sirve» y se lo paso al equipo.';
  return `${mensaje ?? 'Así quedaría el cambio.'}\n\n${next}`;
}

export const APPROVED_REPLY = '¡Listo, quedó aprobado! El equipo de desarrollo va a hacer el cambio tal como lo viste. Te aviso por correo cuando esté listo para la próxima actualización.';
export const REJECTED_REPLY = 'Entendido. Se lo paso al equipo de desarrollo con tu pedido y lo que conversamos. Te aviso por correo cuando esté resuelto.';
export const FAILED_PROTOTYPE_REPLY = 'No pude armar el prototipo de este cambio, así que se lo paso al equipo de desarrollo con tu pedido y lo que conversamos. Te aviso por correo cuando esté resuelto.';

// Befores and afters side by side: antes-1, después-1, antes-2…
function pairs(draft: PrototypeDraft): Array<{ kind: 'antes' | 'despues'; i: number; path: string; caption: string }> {
  const out = [];
  for (let i = 0; i < Math.max(draft.antes.length, draft.despues.length); i++) {
    for (const kind of ['antes', 'despues'] as const) {
      const shot = draft[kind][i];
      if (shot) out.push({ kind, i, path: shot.path, caption: `${kind === 'antes' ? 'Antes' : 'Después'}${shot.nota ? `: ${shot.nota}` : ''}` });
    }
  }
  return out;
}

// Copies the images and the diff into the request and shows them.
async function deliver(n: number, round: number, draft: PrototypeDraft): Promise<PortalRequest> {
  const images: string[] = [];
  const captions: string[] = [];
  for (const shot of pairs(draft)) {
    const file = `p${round}-${shot.kind}-${shot.i + 1}${extname(shot.path).toLowerCase()}`;
    await mkdir(dirname(requestImagePath(n, file)), { recursive: true, mode: 0o700 });
    await copyFile(shot.path, requestImagePath(n, file));
    images.push(file);
    captions.push(shot.caption);
  }
  let patch: string | undefined;
  if (draft.patch) {
    patch = `${round}.diff`;
    await mkdir(dirname(prototypePatchPath(n, patch)), { recursive: true, mode: 0o700 });
    await writeFile(prototypePatchPath(n, patch), `${draft.patch}\n`, { mode: 0o600 });
  }
  return updateRequest(n, (r) => {
    const at = new Date();
    const messageId = addRoninMessage(r, proposedReply(draft.mensaje, round), at, { images, captions });
    (r.prototypes ??= []).push({ round, summary: draft.resumen, ...(patch ? { patch } : {}), messageId, at: at.toISOString() });
    r.status = 'proposed';
    delete r.worker;
    return r;
  });
}

function draw(request: PortalRequest, round: number): Promise<PortalRequest> {
  const n = request.number;
  return makePrototype(
    {
      key: `portal-p-${n}`,
      appName: request.app,
      task: (base) => ({
        type: 'portal-prototype',
        requestNumber: n,
        ...base,
        conversation: request.messages.map((m) => ({ from: m.from, text: m.text, images: m.images.map((file) => requestImagePath(n, file)) })),
        instruction: request.verdict?.instruction ?? '',
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
      log.info(`portal: prototipo ${round} del pedido P-${n} listo`);
      const user = await getUser(shown.userId);
      if (user) await sendPortalMails(shown, [prototypeMail(shown, user, config.portal.url)]);
      return;
    } catch (error) {
      failure = error as Error;
      log.error(`portal: falló el prototipo ${round} del pedido P-${n} (intento ${attempt} de ${ATTEMPTS})`, error);
      if (error instanceof PrototypeDeclined) break;
    }
  }
  try {
    const handed = await updateRequest(n, (r) => {
      r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: `No se pudo armar el prototipo: ${failure?.message.split('\n')[0].slice(0, 300) ?? 'sin detalle'}`, at: new Date().toISOString() };
      addRoninMessage(r, FAILED_PROTOTYPE_REPLY);
      r.status = 'big';
      delete r.worker;
      return r;
    });
    await handOverMails(handed, await getUser(handed.userId));
  } catch (error) {
    log.error(`portal: no se pudo pasar al equipo el pedido P-${n}`, error);
  }
}

export type Decision = 'aprobar' | 'rechazar';

// What the person decided on the prototype on screen. Approved, it's the
// team's to make until the portal opens the PR itself; turned down, it's
// the team's to look at, like a big one.
export async function decideRequest(n: number, decision: Decision, note = ''): Promise<PortalRequest> {
  const decided = await updateRequest(n, (r) => {
    if (r.status !== 'proposed') throw new RequestError('Este pedido no espera tu decisión ahora.');
    const at = new Date();
    r.decision = { kind: decision === 'aprobar' ? 'approved' : 'rejected', at: at.toISOString() };
    if (decision === 'aprobar') {
      r.status = 'approved';
      addRoninMessage(r, APPROVED_REPLY, at);
    } else {
      if (note.trim()) addPersonNote(r, note.trim(), at);
      r.verdict = { ...(r.verdict ?? { summary: '' }), kind: 'big', reason: 'La persona no aprobó el prototipo.', at: at.toISOString() };
      r.status = 'big';
      addRoninMessage(r, REJECTED_REPLY, at);
    }
    return r;
  });
  log.info(`portal: el pedido P-${n} quedó ${decision === 'aprobar' ? 'aprobado' : 'para el equipo (prototipo no aprobado)'}`);
  const user = await getUser(decided.userId);
  if (decided.status === 'big') await handOverMails(decided, user);
  else await sendPortalMails(decided, [await teamMail(decided, user)]);
  return decided;
}
