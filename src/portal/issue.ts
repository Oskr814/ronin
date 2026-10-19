import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { evidenceUrl, publishEvidence } from '../app/index.js';
import { config, LABEL_PORTAL } from '../core/config.js';
import { closeIssueNotPlanned, createIssue, listIssuesWithLabel } from '../core/github.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { getUser, type PortalUser } from './accounts.js';
import { interviewRecord } from './interview.js';
import { sendPortalMails, teamMail } from './notify.js';
import { addEvent, getRequest, patchOf, prototypePatchPath, requestImagePath, RONINS, updateRequest, type PortalRequest } from './requests.js';

// The issue a portal request (#114) becomes in its product repo, with label
// ronin:portal: what the person asked, the conversation, the prototype and
// its diff if there was one.
//   - Approved, or a reported error's small fix (#137): assigned to ronin,
//     which takes it like any issue assigned to it (discoverAssignedIssues →
//     'fix-issue') and opens the PR, starting from the prototype's or the
//     reproduction's diff; follow.ts takes it from there.
//   - Too big, its prototype turned down or impossible to make, or a
//     reported error once ronin tried to reproduce it (#137): for the dev
//     team, assigned to no one; follow.ts tells the person when it closes.

// In the issue's body, so a worker that died between creating the issue
// and noting it finds it instead of opening another.
export const issueMarker = (n: number) => `<!-- ronin:portal P-${n} -->`;

// GitHub caps an issue's body at 65 536 characters; the rest of it takes a
// few thousand at most.
const MAX_PATCH = 40_000;

// What a person wrote, quoted and without pinging anyone.
const quote = (text: string) => text.trim().replace(/@/g, '@​').split('\n').map((line) => `> ${line}`).join('\n');

export interface IssueShot {
  url: string;
  caption: string;
}

export type IssueShots = { prototype: IssueShot[]; attached: IssueShot[]; reproduction?: IssueShot[] };

// Why the team has it, in a line.
function teamReason(request: PortalRequest): string {
  if (request.decision?.kind === 'rejected') return 'La persona vio el prototipo y no lo aprobó (lo que dijo está en la conversación).';
  return request.verdict?.reason ?? 'ronin lo juzgó más grande que un ajuste del portal.';
}

const fencedOutput = (label: string, output: string) => `<details><summary>${label}</summary>\n\n\`\`\`\n${output.replace(/```/g, "'''")}\n\`\`\`\n\n</details>`;

// A table cell of what a person wrote: one line, no pipes, no pings.
const cell = (text: string) => text.replace(/@/g, '@​').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const bullet = (text: string) => text.replace(/@/g, '@​').replace(/\s*\n\s*/g, ' ');

// The interview of a big request (#225): what the person decided, as the
// summary they confirmed (or the last one ronin showed them), what stays
// out, what the team decides, and the questions and answers as they were.
export function interviewSection(request: PortalRequest): string {
  const record = interviewRecord(request);
  if (!record) return '';
  if (record.ended === 'skipped' && !record.rounds.length) return '## Lo que definió la persona\n\nronin le dejó preguntas, pero la persona prefirió enviarlo sin responderlas.';
  const rounds = record.rounds.length;
  const intro = record.ended === 'confirmed'
    ? `ronin le hizo ${rounds === 1 ? 'una ronda' : `${rounds} rondas`} de preguntas y la persona confirmó este resumen antes de enviarlo.`
    : record.understood
      ? `ronin le hizo ${rounds === 1 ? 'una ronda' : `${rounds} rondas`} de preguntas. La persona **no confirmó** este resumen: lo envió sin confirmarlo.`
      : `ronin le hizo ${rounds === 1 ? 'una ronda' : `${rounds} rondas`} de preguntas; estas son sus respuestas.`;
  const u = record.understood;
  const table = u
    ? ['| Tema | Decisión |', '|---|---|', ...u.decisions.map((d) => `| ${cell(d.topic)} | ${cell(d.decision)} |`)].join('\n')
    : ['| Pregunta | Respuesta |', '|---|---|', ...record.rounds.flat().map((a) => `| ${cell(a.question)} | ${a.unsure ? '_Sin decidir: lo decide el equipo._' : cell(a.answer)} |`)].join('\n');
  const raw = record.rounds.map((answers, i) => `${rounds > 1 ? `**Ronda ${i + 1}**\n\n` : ''}${answers.map((a) => `- ${bullet(a.question)} → ${a.unsure ? '_No sé, que lo decida el equipo_' : bullet(a.answer)}`).join('\n')}`).join('\n\n');
  return [
    '## Lo que definió la persona',
    intro,
    table,
    u?.out.length ? `**Queda fuera:** ${u.out.map(bullet).join('; ')}.` : '',
    u?.team.length ? `**Para decidir el equipo:** ${u.team.map(bullet).join('; ')}.` : '',
    u ? `<details><summary>Las preguntas y respuestas tal cual</summary>\n\n${raw}\n\n</details>` : '',
  ].filter(Boolean).join('\n\n');
}

// A reported error's last try at reproducing it: what ronin did, the test
// and the images. A test that never failed goes as what was tried, never as
// proof of the error.
export function reproductionSection(request: PortalRequest, shots: IssueShot[], image: (s: IssueShot) => string): string {
  const bug = request.bug;
  const last = bug?.reproductions.at(-1);
  if (!bug || !last) return bug?.steps ? `## Cómo reproducirlo (según lo entendió ronin)\n\n${bug.steps}` : '';
  const tries = bug.reproductions.length;
  const t = last.test;
  const test = !t ? 'ronin no escribió un test.'
    : [
      `${t.red ? '**El test que falla**' : '**El test que se intentó**'} (${t.kind === 'e2e' ? 'e2e' : 'directo en la capa del error'}): \`${t.name}\`${t.file ? ` en \`${t.file}\`` : ''}.`,
      t.red ? `Rojo en la rama base${t.green ? '; en verde con el arreglo de prueba.' : '.'}` : 'No falla con datos de prueba: no prueba el error, va como lo que se intentó.',
      t.command ? `Se corre con \`${t.command}\`.` : '',
      t.redOutput ? fencedOutput(t.red ? 'Salida en rojo' : 'Salida', t.redOutput) : '',
      t.green && t.greenOutput ? fencedOutput('Salida en verde, con el arreglo', t.greenOutput) : '',
    ].filter(Boolean).join('\n\n');
  return [
    `## Reproducción${tries > 1 ? ` (intento ${tries})` : ''}`,
    last.reproduced ? '**Reproducido** en una copia de la aplicación con datos de prueba.' : '**No se pudo reproducir** con datos de prueba: puede depender de datos reales.',
    bug.steps ? `**Cómo lo entendió ronin al leerlo:**\n\n${bug.steps}` : '',
    last.steps.length ? `**Lo que hizo ronin:**\n\n${last.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : '',
    last.summary ? `**${last.reproduced ? 'Causa' : 'Lo que sospecha ronin'}:**\n\n${last.summary}` : '',
    last.fix === 'big' && last.reason ? `**Por qué el arreglo no es pequeño:** ${last.reason}` : '',
    test,
    shots.length ? shots.map((s) => `**${s.caption}**\n\n${image(s)}`).join('\n\n') : '',
  ].filter(Boolean).join('\n\n');
}

export function portalIssueBody(request: PortalRequest, user: PortalUser | undefined, shots: IssueShots, patch: string | undefined, patchFile: string | undefined, appName?: string): string {
  if (request.status === 'fixing') return fixIssueBody(request, user, shots, patch, patchFile, appName);
  const approved = request.status === 'approved';
  const v = request.verdict;
  const last = request.prototypes?.at(-1);
  const rounds = request.prototypes?.length ?? 0;
  const who = user?.name ?? 'una persona';
  const conversation = request.messages
    .filter((m) => m.text && !m.captions)
    .map((m) => `**${m.from === 'ronin' ? 'ronin' : who}:**\n${m.from === 'ronin' ? m.text : quote(m.text)}`)
    .join('\n\n');
  const image = (s: IssueShot) => `<img src="${s.url}" alt="${s.caption.replace(/"/g, "'")}" width="720">`;
  const truncated = patch !== undefined && patch.length > MAX_PATCH;
  const where = `Pedido **P-${request.number}** del portal de pedidos, de ${who}, en **${appName ?? request.app}** (\`${request.app}\` en ronin.app.json).`;
  const bug = request.bug;
  const repro = bug?.reproductions.at(-1);
  const diffOf = bug ? (repro?.fix === 'small' ? 'la reproducción (el test y el arreglo de prueba)' : 'la reproducción (el test)') : approved ? 'prototipo aprobado' : 'último prototipo';
  const diff = patch
    ? `<details><summary>Diff de${bug ? ' ' : 'l '}${diffOf}</summary>\n\n\`\`\`diff\n${truncated ? `${patch.slice(0, MAX_PATCH)}\n… (recortado)` : patch}\n\`\`\`\n\n</details>${truncated && patchFile ? `\n\nEl diff completo está en el runner: \`${patchFile}\`.` : ''}`
    : '';
  return [
    issueMarker(request.number),
    approved
      ? `${where} Aprobó el prototipo${rounds > 1 ? ` (después de ${rounds - 1} ${rounds === 2 ? 'ajuste' : 'ajustes'})` : ''}: este issue es para hacer ese cambio tal como lo vio.`
      : `${where} ${bug ? 'Es un **reporte de error**, para' : 'Es para'} el equipo de desarrollo: ${teamReason(request)}`,
    approved ? '## El cambio aprobado' : bug ? '## Lo que reporta' : '## Lo que pide',
    approved ? (v?.proposal ?? request.title) : `${request.title}${v?.proposal ? `\n\nLo que ronin le propuso: ${v.proposal}` : ''}`,
    approved ? '' : interviewSection(request),
    shots.prototype.length ? `## ${approved ? 'El prototipo' : `El último prototipo que vio${rounds > 1 ? ` (de ${rounds})` : ''}`}\n\n${shots.prototype.map((s) => `**${s.caption}**\n\n${image(s)}`).join('\n\n')}` : '',
    bug ? reproductionSection(request, shots.reproduction ?? [], image) : '',
    approved ? '## Para implementarlo' : '## Lo que vio ronin',
    approved ? 'Partir del diff del prototipo: es el cambio que la persona vio y aprobó. Completar lo que un borrador deja fuera (tests, tipos, otros tamaños de pantalla que ya muestra el prototipo) sin ampliar el alcance: lo que no esté en el prototipo queda para otro issue.' : '',
    v?.summary ? `**Análisis de ronin al leer el pedido:**\n\n${v.summary}` : '',
    last?.summary ? `**Lo que cambia el prototipo:**\n\n${last.summary}` : '',
    approved && !patch ? 'El prototipo no dejó diff: el después es una maqueta. Hacer el cambio que muestran las imágenes.' : diff,
    `<details><summary>La conversación en el portal</summary>\n\n${conversation}${shots.attached.length ? `\n\n${shots.attached.map(image).join('\n')}` : ''}\n\n</details>`,
    approved ? '' : '_Cuando se cierre este issue, ronin le avisa a la persona por correo: como completado, que quedó resuelto; como no planeado, que el equipo decidió no hacerlo por ahora._',
  ].filter(Boolean).join('\n\n');
}

const MAX_FIX_PATCH = MAX_PATCH;

// A reported error ronin reproduced and fixed in a draft (#137): the issue
// is for making that fix, from the test and the diff.
function fixIssueBody(request: PortalRequest, user: PortalUser | undefined, shots: IssueShots, patch: string | undefined, patchFile: string | undefined, appName?: string): string {
  const who = user?.name ?? 'una persona';
  const conversation = request.messages
    .filter((m) => m.text && !m.captions)
    .map((m) => `**${m.from === 'ronin' ? 'ronin' : who}:**\n${m.from === 'ronin' ? m.text : quote(m.text)}`)
    .join('\n\n');
  const image = (s: IssueShot) => `<img src="${s.url}" alt="${s.caption.replace(/"/g, "'")}" width="720">`;
  const truncated = patch !== undefined && patch.length > MAX_FIX_PATCH;
  const where = `Pedido **P-${request.number}** del portal de pedidos, de ${who}, en **${appName ?? request.app}** (\`${request.app}\` en ronin.app.json).`;
  return [
    issueMarker(request.number),
    `${where} Es un **reporte de error**: ronin lo reprodujo con un test que falla y el arreglo es pequeño. Este issue es para hacer ese arreglo.`,
    '## Lo que reporta',
    request.title,
    reproductionSection(request, shots.reproduction ?? [], image),
    '## Para implementarlo',
    'Partir del diff de la reproducción: el test ya está y el arreglo de prueba lo pasa a verde. Completar lo que un borrador deja fuera (el mismo error en otros lugares, los tests de alrededor) sin ampliar el alcance: lo que no sea este error queda para otro issue.',
    request.verdict?.summary ? `**Análisis de ronin al leer el reporte:**\n\n${request.verdict.summary}` : '',
    patch ? `<details><summary>Diff de la reproducción (el test y el arreglo de prueba)</summary>\n\n\`\`\`diff\n${truncated ? `${patch.slice(0, MAX_FIX_PATCH)}\n… (recortado)` : patch}\n\`\`\`\n\n</details>${truncated && patchFile ? `\n\nEl diff completo está en el runner: \`${patchFile}\`.` : ''}` : '',
    `<details><summary>La conversación en el portal</summary>\n\n${conversation}${shots.attached.length ? `\n\n${shots.attached.map(image).join('\n')}` : ''}\n\n</details>`,
  ].filter(Boolean).join('\n\n');
}

// The last prototype's images and the person's own, on the evidence branch
// (the product repo is private: only the team sees them). Named like an
// exploration finding's, so the 'fix-issue' run shows the afters in the PR
// (and the changelog) and leaves the befores out: the person's images are
// befores too.
async function publishShots(request: PortalRequest): Promise<IssueShots> {
  const last = request.prototypes?.at(-1);
  const shown = last ? request.messages.find((m) => m.id === last.messageId) : undefined;
  const repro = request.bug?.reproductions.at(-1);
  const reproduced = repro ? request.messages.find((m) => m.id === repro.messageId) : undefined;
  const items: Array<{ kind: 'prototype' | 'attached' | 'reproduction'; file: string; caption: string; name: string }> = [];
  const count = { antes: 0, despues: 0 };
  const named = (file: string, kind: 'antes' | 'despues') => `${kind}-${++count[kind]}${extname(file)}`;
  shown?.images.forEach((file, i) => items.push({ kind: 'prototype', file, caption: shown.captions?.[i] ?? 'Prototipo', name: named(file, /-despues-/.test(file) ? 'despues' : 'antes') }));
  // The error is a before; the fix, an after.
  reproduced?.images.forEach((file, i) => items.push({ kind: 'reproduction', file, caption: reproduced.captions?.[i] ?? 'Reproducción', name: named(file, /-arreglo-/.test(file) ? 'despues' : 'antes') }));
  for (const m of request.messages) {
    if (m.from === 'person') m.images.forEach((file) => items.push({ kind: 'attached', file, caption: 'Captura que adjuntó la persona', name: named(file, 'antes') }));
  }
  const result: Required<IssueShots> = { prototype: [], attached: [], reproduction: [] };
  if (!items.length) return result;
  const prefix = `portal/P-${request.number}-${Date.now()}`;
  const files = items.map((item) => ({ src: requestImagePath(request.number, item.file), path: `${prefix}/${item.name}` }));
  const sha = await publishEvidence(activeRepo().productRepoPath, files, `pedido P-${request.number} del portal`);
  items.forEach((item, i) => result[item.kind].push({ url: evidenceUrl(sha, files[i].path), caption: item.caption }));
  return result;
}

export const cancelComment = (n: number) => `La persona canceló el pedido P-${n} desde el portal de pedidos.`;

// Whether a request still needs its issue: ronin's, or the team's.
export const needsIssue = (r: PortalRequest) => (RONINS.includes(r.status) || r.status === 'big') && !r.issue;

// Inside withActiveRepo. The team hears about theirs here, with the link;
// the person already heard when it was handed over.
export async function openPortalIssue(n: number): Promise<void> {
  const request = await getRequest(n);
  if (!request || !needsIssue(request)) return;
  const approved = RONINS.includes(request.status);
  const user = await getUser(request.userId);
  const existing = (await listIssuesWithLabel(LABEL_PORTAL)).find((i) => i.body.includes(issueMarker(n)));
  let issue: { number: number; url: string };
  if (existing) issue = { number: existing.number, url: `https://github.com/${activeRepo().productRepo}/issues/${existing.number}` };
  else {
    const file = patchOf(request);
    const patch = file ? await readFile(prototypePatchPath(n, file), 'utf8').catch(() => undefined) : undefined;
    const body = portalIssueBody(request, user, await publishShots(request), patch?.trim(), file ? prototypePatchPath(n, file) : undefined, activeRepo().portal?.apps[request.app]?.name);
    issue = await createIssue(request.title, body, [LABEL_PORTAL], approved ? [config.githubLogin] : []);
  }
  const updated = await updateRequest(n, (r) => {
    r.issue = issue;
    addEvent(r, { kind: 'issue', number: issue.number, team: !approved });
    delete r.worker;
    return r;
  });
  // Cancelled while the issue was being written: close it too.
  if (updated.status === 'cancelled') {
    await closeIssueNotPlanned(issue.number, cancelComment(n));
    return;
  }
  log.info(`portal: el pedido P-${n} ${approved ? (request.status === 'fixing' ? 'con su arreglo' : 'aprobado') : 'para el equipo'} es el issue #${issue.number}`);
  if (!approved && !existing) await sendPortalMails(updated, [await teamMail(updated, user)]);
}
