import { config } from '@platform/config/config.js';
import { loadRepos } from '@platform/config/repos.js';
import { commentOnIssue } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import { withActiveRepo } from '@platform/agents/repo-context.js';
import { recipientsFor } from '@platform/notify/notifications.js';
import { getUser } from './accounts.js';
import type { ImageUpload } from './images.js';
import { personRepliedMail, teamWroteMail } from './mail.js';
import { sendPortalMails } from './notify.js';
import { addEvent, nextMessageId, RequestError, saveImages, TEAM_HELD, updateRequest, type PortalRequest } from './requests.js';

// The team writes to the person (#353): while the team has a request
// (TEAM_HELD) and until it closes, someone of the team writes from its page
// on the tablero, and the person answers from the portal. ronin doesn't
// read any of it: the request stays as it is. Each message reaches the
// other side by mail, and, once the request has an issue, is copied there
// as a comment so whoever works on it (ronin too) has the context. Before
// the issue, the conversation goes in its body when it opens (issue.ts).

const NOT_TEAMS = 'Este pedido ya no está en manos del equipo.';

// A message of the team's or the person's, copied to the issue as ronin.
const quote = (text: string) => text.trim().replace(/@/g, '@​').split('\n').map((line) => `> ${line}`).join('\n');
function issueComment(heading: string, text: string, images: number, n: number): string {
  return [`**${heading}**`, text ? quote(text) : '_(sin texto)_', images ? `_Adjuntó ${images === 1 ? 'una imagen' : `${images} imágenes`}: está${images === 1 ? '' : 'n'} en el pedido P-${n} del tablero._` : ''].filter(Boolean).join('\n\n');
}

async function copyToIssue(request: PortalRequest, body: string): Promise<void> {
  if (!request.issue) return;
  try {
    const entry = (await loadRepos()).find((e) => e.productRepo === request.repo);
    if (!entry) return;
    await withActiveRepo(entry, () => commentOnIssue(request.issue!.number, body));
  } catch (error) {
    log.error(`portal: no se pudo copiar al issue #${request.issue.number} un mensaje del pedido P-${request.number}`, error);
  }
}

// Someone of the team (`by`, their GitHub login) writes to the person.
export async function writeToPerson(n: number, input: { text: string; images: ImageUpload[]; by: string }, now = new Date()): Promise<PortalRequest> {
  if (!input.text.trim() && !input.images.length) throw new RequestError('Escribe algo o adjunta una imagen.');
  const written = await updateRequest(n, async (r) => {
    if (!TEAM_HELD.includes(r.status)) throw new RequestError(NOT_TEAMS);
    const id = nextMessageId(r);
    r.messages.push({ id, from: 'team', by: input.by, text: input.text.trim(), images: await saveImages(n, id, input.images), at: now.toISOString() });
    addEvent(r, { kind: 'team-message', by: input.by }, now);
    delete r.personReplied;
    return r;
  });
  log.info(`portal: ${input.by} le escribió a la persona del pedido P-${n}`);
  const user = await getUser(written.userId);
  if (user) await sendPortalMails(written, [teamWroteMail(written, user, config.portal.url, input.text.trim(), input.images.length)]);
  await copyToIssue(written, issueComment(`Equipo → persona (${input.by}, desde el tablero)`, input.text, input.images.length, n));
  return written;
}

// Whether the person can answer the team now: the team has it and wrote to them.
export const canReplyToTeam = (r: Pick<PortalRequest, 'status' | 'messages'>) => TEAM_HELD.includes(r.status) && r.messages.some((m) => m.from === 'team');

// The person answers the team: it goes to them, not to ronin.
export async function replyToTeam(n: number, text: string, images: ImageUpload[], now = new Date()): Promise<PortalRequest> {
  const replied = await updateRequest(n, async (r) => {
    if (!canReplyToTeam(r)) throw new RequestError('Este pedido no espera una respuesta ahora.');
    const id = nextMessageId(r);
    r.messages.push({ id, from: 'person', to: 'team', text: text.trim(), images: await saveImages(n, id, images), at: now.toISOString() });
    addEvent(r, { kind: 'person-reply' }, now);
    r.personReplied = now.toISOString();
    return r;
  });
  const user = await getUser(replied.userId);
  const entry = (await loadRepos().catch(() => [])).find((e) => e.productRepo === replied.repo);
  await sendPortalMails(replied, [personRepliedMail(replied, user, await recipientsFor(replied.repo, entry, 'pedido-equipo'), text.trim(), images.length, config.dashboard.url)]);
  await copyToIssue(replied, issueComment(`Persona → equipo (${user?.name ?? 'la persona'}, desde el portal)`, text, images.length, n));
  return replied;
}

// Someone of the team opened it: «La persona respondió» goes.
export async function seenByTeam(n: number): Promise<void> {
  await updateRequest(n, (r) => {
    delete r.personReplied;
  });
}
