import { appsTouched } from '../product-app/manifest.js';
import { config, LABEL_AUTO_MERGE, LABEL_MANAGED } from '@platform/config/config.js';
import { setIssueState } from '@platform/github/github.js';
import { log } from '@platform/logger.js';
import { withActiveRepo, type RepoEntry } from '@platform/agents/repo-context.js';
import type { Session } from '../access/http.js';
import type { ItemDetail, ItemRef } from './detail.js';
import type { RepoGithub } from './github.js';
import { assignIssue, closeIssue, commentOnIssue, type Posted } from '@platform/github/github-as-user.js';
import { DomainError } from '@platform/errors.js';
import { getDb } from '@platform/db/db.js';
import { createCommand, type Command } from '../commands/store.js';
import { launchPreviewWorker } from '../previews/index.js';

// What can be asked of ronin from an item's page (#85). Each action is a
// command that already exists on GitHub, and the dashboard writes it as
// whoever is logged in (#93): "@ronin-agent /resolve-conflicts" on the PR,
// with their GitHub token. From there it's a comment like any other — its
// webhook, the mention handler, the worker that answers it — and GitHub
// shows who asked.
//
// Some go straight to ronin instead (#446), when there's a database: they're
// kept as a command (commands/store.ts) and their worker starts without
// waiting for GitHub. Nothing is written on the issue or the PR; ronin's
// answers are on the item's page.
//
// An issue ronin doesn't manage yet can be handed to it: assigned to
// its account, which it takes like any issue assigned on GitHub
// (discoverAssignedIssues) and, if what's asked isn't clear, asks on the
// issue before touching code. Or a /spike first, on one of the repo's
// apps, a /spec that turns it into a spec in a draft PR, or an /explore with the issue as its focus (#376). Any open issue can also be closed, as not planned, with
// its reason as a comment first.

export type ActionId = 'resolve-conflicts' | 'preview' | 'preview-stop' | 'auto-merge-on' | 'auto-merge-off' | 'unblock' | 'assign' | 'spike' | 'spec' | 'explore' | 'close-issue';

export interface ActionView {
  id: ActionId;
  label: string;
  // How it's written on GitHub, to recognize it.
  command: string;
  help: string;
  // The issue or PR it acts on and comments on: an issue's actions on its PR go to the PR.
  target: number;
  // Whether it takes words: what to prepare for a preview, the answer that unblocks an issue.
  text?: { required: boolean; label: string; placeholder: string };
  // The app it runs on, one of the repo's ronin.app.json: `{app}` in the preview stands for it.
  apps?: string[];
  // The one picked to start with, and why, next to it in the list: for a
  // preview, the one up now or the only app the PR changes.
  app?: string;
  appNote?: string;
  // The one that fits what the item is waiting for.
  primary?: boolean;
  // The comment that will be left, shown before it's sent; with text, `…` stands for it.
  preview: string;
  // Asked straight to ronin, without a comment on GitHub (#446).
  direct?: boolean;
}

// The actions that go straight to ronin, with a database to keep them.
const DIRECT: ReadonlySet<ActionId> = new Set(['preview', 'preview-stop']);
const isDirect = (id: ActionId) => DIRECT.has(id) && getDb() !== null;

const MAX_TEXT = 4000;

// `paths`: each app's folder, to tell which one a PR changes.
export function listActions(ref: ItemRef, gh: RepoGithub | undefined, detail: ItemDetail | undefined, login: string, apps: string[] = [], paths: Record<string, string> = {}): ActionView[] {
  const actions: Array<Omit<ActionView, 'preview'>> = [];
  const prNumber = ref.kind === 'pr' ? ref.number : ref.pr;
  const pr = prNumber !== undefined ? gh?.prs.find((p) => p.number === prNumber) : undefined;
  const prDoc = detail?.pr;
  if (pr && prNumber !== undefined) {
    const on = ref.kind === 'issue' ? ` en #${prNumber}` : '';
    const conflicting = prDoc?.mergeable === 'CONFLICTING';
    actions.push({
      id: 'resolve-conflicts', label: `Resolver conflictos${on}`, command: '/resolve-conflicts', target: prNumber, primary: conflicting,
      help: conflicting ? `Trae ${pr.baseRefName} al PR y resuelve lo que git no pudo.` : `No tiene conflictos con ${pr.baseRefName}: solo lo pone al día.`,
    });
    const preview = gh?.previews.find((p) => p.prNumber === prNumber);
    // With several apps, which one: the one up now, or the only one the PR changes.
    const touched = apps.length > 1 && prDoc?.files ? appsTouched(Object.fromEntries(apps.map((a) => [a, { path: paths[a] ?? '' }])), prDoc.files) : [];
    const up = preview && apps.includes(preview.appName) ? preview.appName : undefined;
    const pick = up ? { app: up, appNote: 'arriba ahora' } : touched.length === 1 ? { app: touched[0], appNote: 'la que cambia el PR' } : {};
    actions.push({
      id: 'preview', label: `${preview ? 'Actualizar la preview' : 'Levantar una preview'}${on}`, command: '/preview', target: prNumber,
      ...(apps.length > 1 ? { apps, ...pick } : {}),
      help: preview ? 'La vuelve a levantar con el código de ahora.' : 'Con los datos que piden los pasos de prueba del PR.',
      text: { required: false, label: 'Qué preparar, además de los pasos de prueba (opcional)', placeholder: 'Por ejemplo: un cliente con más de 10 pedidos creados' },
    });
    if (preview) actions.push({ id: 'preview-stop', label: `Bajar la preview${on}`, command: '/preview stop', target: prNumber, help: `${preview.appName}, arriba ahora.` });
    const autoMerge = prDoc?.labels.includes(LABEL_AUTO_MERGE);
    actions.push(autoMerge
      ? { id: 'auto-merge-off', label: `Desactivar el auto-merge${on}`, command: '/auto-merge off', target: prNumber, help: 'Saca el label: el PR espera a que alguien lo mergee.' }
      : { id: 'auto-merge-on', label: `Activar el auto-merge${on}`, command: '/auto-merge', target: prNumber, help: 'Se mergea solo cuando esté aprobado y con los checks en verde.' });
  }
  const issue = ref.kind === 'issue' ? gh?.issues.find((i) => i.number === ref.number) : undefined;
  const open = ref.kind === 'issue' ? gh?.openIssues.find((i) => i.number === ref.number) : undefined;
  if (open && !issue && !open.labels.includes(LABEL_MANAGED)) {
    const before: Array<Omit<ActionView, 'preview'>> = [{
      id: 'assign', label: 'Asignar a ronin', command: `assignee @${config.githubLogin}`, target: ref.number, primary: true,
      help: 'Lo toma en el próximo tick: lee el issue con sus comentarios y, si no queda claro qué hacer, pregunta en el issue antes de tocar código. Si queda claro, abre un PR.',
      text: { required: false, label: 'Contexto para ronin (opcional): queda como comentario tuyo antes de asignarlo', placeholder: 'Por ejemplo: el caso que falla es con un cliente sin pedidos' },
    }];
    if (apps.length) {
      before.push({
        id: 'spike', label: 'Investigar (spike)', command: '/spike', target: ref.number, apps,
        help: 'Investiga en solo lectura y agrega una sección de contexto al issue. No lo toma ni abre un PR.',
        text: { required: false, label: 'Qué investigar (opcional)', placeholder: 'Por ejemplo: de dónde sale el total del checkout' },
      });
      before.push({
        id: 'spec', label: 'Pedir un spec', command: '/spec', target: ref.number, apps,
        help: 'Lo convierte en un spec: investiga, pregunta en el issue lo que falte y abre un PR draft con el spec. Lo implementa cuando marcás el PR ready for review.',
        text: { required: false, label: 'Qué tener en cuenta (opcional)', placeholder: 'Por ejemplo: que se pueda hacer en varias entregas' },
      });
      before.push({
        id: 'explore', label: 'Explorar', command: '/explore', target: ref.number, apps,
        help: 'Usa la app como cada rol con lo que pide el issue como foco, y deja fichas con el antes y el después en el PR de exploración. No lo toma ni cambia el código.',
        text: { required: false, label: 'En qué fijarse, además de lo que dice el issue (opcional)', placeholder: 'Por ejemplo: sobre todo en el teléfono' },
      });
    }
    actions.unshift(...before);
  }
  if (issue?.status === 'blocked') {
    actions.unshift({
      id: 'unblock', label: 'Responder y destrabar', command: 'ronin:in-progress', target: ref.number, primary: true,
      help: 'Comentás tu respuesta en el issue y ronin lo vuelve a pasar a ronin:in-progress.',
      text: { required: true, label: 'Tu respuesta', placeholder: 'Lo que hacía falta decidir o resolver' },
    });
  }
  // Last: the one that ends it.
  if (issue || open) {
    actions.push({
      id: 'close-issue', label: 'Cerrar el issue', command: 'close', target: ref.number,
      help: prNumber !== undefined
        ? `Lo cierra como no planeado. El PR #${prNumber} queda abierto: para cerrarlo también, usá Cerrar en el PR.`
        : 'Lo cierra como no planeado. ronin deja de trabajarlo.',
      text: { required: false, label: 'Por qué (opcional): queda como comentario tuyo antes de cerrarlo', placeholder: 'Por ejemplo: ya no hace falta, lo cubre otro issue' },
    });
  }
  return actions.map((a) => ({ ...a, preview: actionComment(a, a.text ? '…' : undefined, a.apps ? '{app}' : undefined), ...(isDirect(a.id) ? { direct: true } : {}) }));
}

// The comment written as the person, which the page also shows before it's
// sent: the command after the mention, and what to prepare below it (the
// /preview parser reads the lines after the command too). The answer that
// unblocks an issue is just the answer, and so is the context that goes
// with an assignment: a mention there would also be read as a request. A
// /spike, /spec or /explore takes its app and instruction on one line, as
// "Nuevo issue" writes them.
export function actionComment(action: Pick<ActionView, 'id' | 'command'>, text?: string, app?: string): string {
  if (action.id === 'unblock' || action.id === 'assign' || action.id === 'close-issue') return text ?? '';
  // A preview keeps what to prepare below, on its own lines.
  if (app && action.id === 'preview') return `@${config.githubLogin} ${action.command} ${app}${text ? `\n\n${text}` : ''}`;
  if (app) return `@${config.githubLogin} ${action.command} ${app}${text ? ` ${text}` : ''}`;
  return `@${config.githubLogin} ${action.command}${text ? `\n\n${text}` : ''}`;
}

// A 409: the item isn't in a state for it.
export class ActionError extends DomainError {
  constructor(message: string) {
    super(message, { status: 409 });
  }
}

export async function runAction(
  entry: RepoEntry,
  ref: ItemRef,
  gh: RepoGithub | undefined,
  detail: ItemDetail | undefined,
  session: Session,
  id: string,
  rawText?: unknown,
  post: (token: string, repo: string, number: number, body: string) => Promise<Posted> = commentOnIssue,
  apps: string[] = [],
  rawApp?: unknown,
  assign: (token: string, repo: string, number: number, assignees: string[]) => Promise<{ url: string }> = assignIssue,
  close: (token: string, repo: string, number: number) => Promise<{ url: string }> = closeIssue,
): Promise<{ url?: string; command?: Command; existing?: boolean }> {
  const action = listActions(ref, gh, detail, session.login, apps).find((a) => a.id === id);
  if (!action) throw new ActionError('Esa acción no está disponible para este ítem ahora.');
  let text = typeof rawText === 'string' ? rawText.trim().slice(0, MAX_TEXT) : '';
  if (action.text?.required && !text) throw new ActionError('Falta el texto.');
  if (!action.text && text) throw new ActionError('Esta acción no lleva texto.');
  const app = typeof rawApp === 'string' ? rawApp : '';
  if (action.apps && !action.apps.includes(app)) throw new ActionError(`Falta la app: una de ${action.apps.join(', ')}.`);
  if (action.apps && action.id !== 'preview') text = text.replace(/\s+/g, ' ');

  if (action.direct) return askRonin(entry, action, session.login, text, app);
  if (action.id === 'assign') {
    // The context first, so it's on the issue when ronin reads it.
    if (text) await post(session.token, entry.productRepo, action.target, text);
    const assigned = await assign(session.token, entry.productRepo, action.target, [config.githubLogin]);
    log.info(`tablero: ${session.login} le asignó ${entry.productRepo}#${action.target} a ronin`);
    return assigned;
  }
  if (action.id === 'close-issue') {
    // The reason first, so it's on the issue when it closes.
    if (text) await post(session.token, entry.productRepo, action.target, text);
    const closed = await close(session.token, entry.productRepo, action.target);
    log.info(`tablero: ${session.login} cerró ${entry.productRepo}#${action.target}`);
    return closed;
  }
  const posted = await post(session.token, entry.productRepo, action.target, actionComment(action, text || undefined, app || undefined));
  log.info(`tablero: ${session.login} pidió ${action.id} en ${entry.productRepo}#${action.target} (${posted.url})`);
  // The answer is all the person writes; putting the issue back in the
  // pipeline is ronin's, as when someone moves the label by hand.
  if (action.id === 'unblock') await withActiveRepo(entry, () => setIssueState(action.target, 'in-progress'));
  return { url: posted.url };
}

// A preview (or taking it down) asked straight to ronin: the command, and
// its worker launched with it to answer there. Asked again while the first
// waits or runs, the first, with who asked for it.
async function askRonin(entry: RepoEntry, action: ActionView, login: string, text: string, app: string): Promise<{ command: Command; existing: boolean }> {
  const db = getDb()!;
  const stop = action.id === 'preview-stop';
  const args = stop ? undefined : [app, text].filter(Boolean).join('\n\n') || undefined;
  const { command, existing } = await createCommand(db, {
    repo: entry.productRepo, number: action.target, kind: action.id, requestedBy: login,
    args: { ...(app ? { app } : {}), ...(text ? { text } : {}) },
    dedupeKey: `preview:${entry.productRepo}#${action.target}`,
  });
  if (existing) return { command, existing };
  launchPreviewWorker({ repo: entry.productRepo, prNumber: action.target, ...(stop ? { action: 'stop' as const } : { action: 'up' as const, ...(args ? { args } : {}) }), command: command.id });
  log.info(`tablero: ${login} pidió ${action.id} en ${entry.productRepo}#${action.target} (comando ${command.id})`);
  return { command, existing };
}

// A comment on the item's issue or PR (its tab's), as the person, from the
// box under its conversation: the same comment they'd leave on GitHub, and
// ronin reads it as such, when it takes the issue or when it's mentioned.
export async function runComment(
  entry: RepoEntry,
  detail: ItemDetail | undefined,
  session: Session,
  on: 'issue' | 'pr',
  rawText: unknown,
  post: (token: string, repo: string, number: number, body: string) => Promise<Posted> = commentOnIssue,
): Promise<{ url: string; number: number; comment: { author: string; body: string; createdAt: string; url: string } }> {
  const doc = on === 'issue' ? detail?.issue : detail?.pr;
  if (!doc) throw new ActionError(on === 'issue' ? 'Este ítem no tiene un issue.' : 'Este ítem no tiene un PR.');
  const text = typeof rawText === 'string' ? rawText.trim().slice(0, MAX_TEXT) : '';
  if (!text) throw new ActionError('Falta el texto.');
  const posted = await post(session.token, entry.productRepo, doc.number, text);
  log.info(`tablero: ${session.login} comentó en ${entry.productRepo}#${doc.number} (${posted.url})`);
  // As the item's page shows it, for the dashboard's cache (items/routes.ts).
  return { url: posted.url, number: doc.number, comment: { author: session.login, body: text, createdAt: new Date().toISOString(), url: posted.url } };
}
