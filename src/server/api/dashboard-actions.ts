import { launchConflictsWorker } from '../../commands/conflicts.js';
import { applyAutoMergeCommand } from '../../commands/auto-merge.js';
import { LABEL_AUTO_MERGE } from '../../core/config.js';
import { postIssueComment, setIssueState } from '../../core/github.js';
import { log } from '../../core/logger.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';
import { launchPreviewWorker } from '../../preview/preview.js';
import type { ItemDetail, ItemRef } from './dashboard-detail.js';
import type { RepoGithub } from './dashboard-github.js';

// What can be asked of ronin from an item's page (#85). Each action is a
// command that already exists on GitHub, run by the same code: ronin first
// comments on the issue or PR "<login> pidió `/x` desde el tablero", and
// that comment takes the place of the one a person would have written — the
// worker answers it, and the PR keeps the record of who asked for what.
// The comment doesn't mention ronin, so no mention scan ever picks it up
// again.

export type ActionId = 'resolve-conflicts' | 'preview' | 'preview-stop' | 'auto-merge-on' | 'auto-merge-off' | 'unblock';

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
  // The one that fits what the item is waiting for.
  primary?: boolean;
  // The comment ronin will leave, shown before it's sent; with text, `> …` stands for it.
  preview: string;
}

const MAX_TEXT = 4000;

export function listActions(ref: ItemRef, gh: RepoGithub | undefined, detail: ItemDetail | undefined, login: string): ActionView[] {
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
    actions.push({
      id: 'preview', label: `${preview ? 'Actualizar la preview' : 'Levantar una preview'}${on}`, command: '/preview', target: prNumber,
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
  if (issue?.status === 'blocked') {
    actions.unshift({
      id: 'unblock', label: 'Responder y destrabar', command: 'ronin:in-progress', target: ref.number, primary: true,
      help: 'Comenta tu respuesta en el issue y lo vuelve a pasar a ronin:in-progress.',
      text: { required: true, label: 'Tu respuesta', placeholder: 'Lo que hacía falta decidir o resolver' },
    });
  }
  return actions.map((a) => ({ ...a, preview: actionComment(a, login, a.text ? '…' : undefined) }));
}

const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');

// The comment ronin leaves, which the page also shows before it's sent.
export function actionComment(action: Pick<ActionView, 'id' | 'command'>, login: string, text?: string): string {
  if (action.id === 'unblock') return `**${login}** respondió desde el tablero:\n\n${quote(text ?? '')}\n\nLo vuelvo a pasar a \`ronin:in-progress\`.`;
  return `**${login}** pidió \`${action.command}\` desde el tablero.${text ? `\n\n${quote(text)}` : ''}`;
}

export class ActionError extends Error {}

export async function runAction(entry: RepoEntry, ref: ItemRef, gh: RepoGithub | undefined, detail: ItemDetail | undefined, login: string, id: string, rawText?: unknown): Promise<{ url: string }> {
  const action = listActions(ref, gh, detail, login).find((a) => a.id === id);
  if (!action) throw new ActionError('Esa acción no está disponible para este ítem ahora.');
  const text = typeof rawText === 'string' ? rawText.trim().slice(0, MAX_TEXT) : '';
  if (action.text?.required && !text) throw new ActionError('Falta el texto.');
  if (!action.text && text) throw new ActionError('Esta acción no lleva texto.');

  return withActiveRepo(entry, async () => {
    const posted = await postIssueComment(action.target, actionComment(action, login, text || undefined));
    const comment = { id: posted.id, kind: 'issue' as const };
    log.info(`tablero: ${login} pidió ${action.id} en ${entry.productRepo}#${action.target} (${posted.url})`);
    const repo = entry.productRepo;
    switch (action.id) {
      case 'resolve-conflicts':
        launchConflictsWorker({ repo, prNumber: action.target, comment });
        break;
      case 'preview':
        launchPreviewWorker({ repo, prNumber: action.target, action: 'up', ...(text ? { args: text } : {}), comment });
        break;
      case 'preview-stop':
        launchPreviewWorker({ repo, prNumber: action.target, action: 'stop', comment });
        break;
      case 'auto-merge-on':
      case 'auto-merge-off':
        await applyAutoMergeCommand(action.target, comment, action.id === 'auto-merge-on' ? 'on' : 'off');
        break;
      case 'unblock':
        await setIssueState(action.target, 'in-progress');
        break;
    }
    return { url: posted.url };
  });
}
