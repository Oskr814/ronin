import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { publishEvidence, evidenceUrl } from '../app/index.js';
import { config, LABEL_AUTO_MERGE, LABEL_PORTAL } from '../core/config.js';
import { addIssueLabel, createIssue, getIssueState, getPullRequestStatus, listIssuesWithLabel, listPrClosingIssues } from '../core/github.js';
import { log } from '../core/logger.js';
import { activeRepo } from '../core/repo-context.js';
import { getUser, type PortalUser } from './accounts.js';
import { doneMail, teamPrMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addRoninMessage, getRequest, listRequests, prototypePatchPath, requestImagePath, updateRequest, type PortalRequest } from './requests.js';

// An approved prototype (#114) becomes ronin's work like any issue assigned
// to it: an issue in the product repo, assigned to ronin, that carries what
// the person asked, the prototype they approved and its diff.
// discoverAssignedIssues takes it, the 'fix-issue' run makes the change and
// opens the PR. The tick then puts ronin:auto-merge on that PR — it merges
// once a dev approves it and CI is green (auto-merge.ts) — and, when it
// merged, tells the person it goes out in the next release.

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

export function approvedIssueBody(request: PortalRequest, user: PortalUser | undefined, shots: { prototype: IssueShot[]; attached: IssueShot[] }, patch: string | undefined, patchFile: string | undefined, appName?: string): string {
  const v = request.verdict;
  const last = request.prototypes?.at(-1);
  const who = user?.name ?? 'una persona';
  const conversation = request.messages
    .filter((m) => m.text && !m.captions)
    .map((m) => `**${m.from === 'ronin' ? 'ronin' : who}:**\n${m.from === 'ronin' ? m.text : quote(m.text)}`)
    .join('\n\n');
  const image = (s: IssueShot) => `<img src="${s.url}" alt="${s.caption.replace(/"/g, "'")}" width="720">`;
  const truncated = patch !== undefined && patch.length > MAX_PATCH;
  return [
    issueMarker(request.number),
    `Pedido **P-${request.number}** del portal de pedidos, de ${who}, en **${appName ?? request.app}** (\`${request.app}\` en ronin.app.json). Aprobó el prototipo${(request.prototypes?.length ?? 0) > 1 ? ` (después de ${request.prototypes!.length - 1} ${request.prototypes!.length === 2 ? 'ajuste' : 'ajustes'})` : ''}: este issue es para hacer ese cambio tal como lo vio.`,
    '## El cambio aprobado',
    v?.proposal ?? request.title,
    shots.prototype.length ? `## El prototipo\n\n${shots.prototype.map((s) => `**${s.caption}**\n\n${image(s)}`).join('\n\n')}` : '',
    '## Para implementarlo',
    'Partir del diff del prototipo: es el cambio que la persona vio y aprobó. Completar lo que un borrador deja fuera (tests, tipos, otros tamaños de pantalla que ya muestra el prototipo) sin ampliar el alcance: lo que no esté en el prototipo queda para otro issue.',
    v?.summary ? `**Análisis de ronin al leer el pedido:**\n\n${v.summary}` : '',
    last?.summary ? `**Lo que cambia el prototipo:**\n\n${last.summary}` : '',
    patch
      ? `<details><summary>Diff del prototipo aprobado</summary>\n\n\`\`\`diff\n${truncated ? `${patch.slice(0, MAX_PATCH)}\n… (recortado)` : patch}\n\`\`\`\n\n</details>${truncated && patchFile ? `\n\nEl diff completo está en el runner: \`${patchFile}\`.` : ''}`
      : 'El prototipo no dejó diff: el después es una maqueta. Hacer el cambio que muestran las imágenes.',
    `<details><summary>La conversación en el portal</summary>\n\n${conversation}${shots.attached.length ? `\n\n${shots.attached.map(image).join('\n')}` : ''}\n\n</details>`,
  ].filter(Boolean).join('\n\n');
}

// The last prototype's images and the person's own, on the evidence branch
// (the product repo is private: only the team sees them). Named like an
// exploration finding's, so the 'fix-issue' run shows the afters in the PR
// (and the changelog) and leaves the befores out: the person's images are
// befores too.
async function publishShots(request: PortalRequest): Promise<{ prototype: IssueShot[]; attached: IssueShot[] }> {
  const last = request.prototypes?.at(-1);
  const shown = last ? request.messages.find((m) => m.id === last.messageId) : undefined;
  const items: Array<{ kind: 'prototype' | 'attached'; file: string; caption: string; name: string }> = [];
  const count = { antes: 0, despues: 0 };
  const named = (file: string, kind: 'antes' | 'despues') => `${kind}-${++count[kind]}${extname(file)}`;
  shown?.images.forEach((file, i) => items.push({ kind: 'prototype', file, caption: shown.captions?.[i] ?? 'Prototipo', name: named(file, /-despues-/.test(file) ? 'despues' : 'antes') }));
  for (const m of request.messages) {
    if (m.from === 'person') m.images.forEach((file) => items.push({ kind: 'attached', file, caption: 'Captura que adjuntó la persona', name: named(file, 'antes') }));
  }
  const result = { prototype: [] as IssueShot[], attached: [] as IssueShot[] };
  if (!items.length) return result;
  const prefix = `portal/P-${request.number}-${Date.now()}`;
  const files = items.map((item) => ({ src: requestImagePath(request.number, item.file), path: `${prefix}/${item.name}` }));
  const sha = await publishEvidence(activeRepo().productRepoPath, files, `pedido P-${request.number} del portal`);
  items.forEach((item, i) => result[item.kind].push({ url: evidenceUrl(sha, files[i].path), caption: item.caption }));
  return result;
}

// Inside withActiveRepo, for an approved request without its issue yet.
export async function openApprovedIssue(n: number): Promise<void> {
  const request = await getRequest(n);
  if (!request || request.status !== 'approved' || request.issue) return;
  const existing = (await listIssuesWithLabel(LABEL_PORTAL)).find((i) => i.body.includes(issueMarker(n)));
  let issue: { number: number; url: string };
  if (existing) issue = { number: existing.number, url: `https://github.com/${activeRepo().productRepo}/issues/${existing.number}` };
  else {
    const user = await getUser(request.userId);
    const file = request.prototypes?.at(-1)?.patch;
    const patch = file ? await readFile(prototypePatchPath(n, file), 'utf8').catch(() => undefined) : undefined;
    const body = approvedIssueBody(request, user, await publishShots(request), patch?.trim(), file ? prototypePatchPath(n, file) : undefined, activeRepo().portal?.apps[request.app]?.name);
    issue = await createIssue(request.title, body, [LABEL_PORTAL], [config.githubLogin]);
  }
  await updateRequest(n, (r) => {
    r.issue = issue;
    delete r.worker;
  });
  log.info(`portal: el pedido P-${n} aprobado es el issue #${issue.number}`);
}

export const PR_READY_REPLY = 'Ya hice el cambio. Ahora una persona del equipo lo revisa antes de publicarlo; te aviso por correo cuando esté listo.';
export const DONE_REPLY = '¡Listo! El cambio ya está hecho y sale en la próxima actualización de la aplicación.';

async function finish(request: PortalRequest): Promise<void> {
  const done = await updateRequest(request.number, (r) => {
    r.status = 'done';
    addRoninMessage(r, DONE_REPLY);
    return r;
  });
  log.info(`portal: el pedido P-${request.number} quedó listo (issue #${request.issue?.number})`);
  const user = await getUser(done.userId);
  if (user) await sendPortalMails(done, [doneMail(done, user, config.portal.url)]);
}

// The tick, inside withActiveRepo: follows this repo's approved requests.
// Their PR, once ronin opened it, gets ronin:auto-merge and the team hears
// it waits for an approval; once it merged (its issue closed as done), the
// person hears it goes out in the next release. An issue closed any other
// way is the dev team's call, followed in stage 5.
export async function reconcileApproved(): Promise<void> {
  const repo = activeRepo().productRepo;
  const approved = (await listRequests()).filter((r) => r.repo === repo && r.status === 'approved' && r.issue);
  if (!approved.length) return;
  let closing: Record<number, number[]> | undefined;
  for (const request of approved) {
    const issue = request.issue!.number;
    try {
      if (request.pr) {
        const pr = await getPullRequestStatus(request.pr);
        if (pr.state === 'MERGED') await finish(request);
        else if (pr.state === 'CLOSED') {
          // Closed without merging: whatever PR closes the issue next is the one.
          await updateRequest(request.number, (r) => { delete r.pr; });
          log.info(`portal: el PR #${request.pr} del pedido P-${request.number} se cerró sin merge`);
        }
        continue;
      }
      closing ??= await listPrClosingIssues();
      const pr = Object.entries(closing).find(([, issues]) => issues.includes(issue))?.[0];
      if (pr) {
        await addIssueLabel(Number(pr), LABEL_AUTO_MERGE);
        const updated = await updateRequest(request.number, (r) => {
          r.pr = Number(pr);
          addRoninMessage(r, PR_READY_REPLY);
          return r;
        });
        log.info(`portal: el pedido P-${request.number} tiene el PR #${pr}, con ${LABEL_AUTO_MERGE}`);
        await sendPortalMails(updated, [teamPrMail(updated, await getUser(updated.userId), config.notifyTo, `https://github.com/${repo}/pull/${pr}`)]);
        continue;
      }
      const state = await getIssueState(issue);
      if (state.state === 'CLOSED' && state.stateReason === 'COMPLETED') await finish(request);
    } catch (error) {
      log.error(`portal: no se pudo seguir el pedido P-${request.number} (issue #${issue})`, error);
    }
  }
}
