import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { addIssueAssignees, createPullRequest, getIssueBody, getPullRequestStatus, postIssueComment, replyToComment, resolveReviewThread, setIssueBody, setPullRequestBody } from '../github/github.js';
import { closingRefs, HELP_FOOTER_MARKER } from '../github/pr-body.js';
import { host } from '../host/host.js';
import { asAgent, type AgentUser } from '../agents/agent-user.js';
import { ActionRefused, prNumberOf, type CheckoutState, type RunScope, type ValidAction } from './catalog.js';

// What each action does, once catalog.ts accepted it: as ronin, with its
// write token — the agent only ever sees the result. Called inside the
// run's withActiveRepo, so github.ts writes to the run's repo.

// The run's checkout, and how to run git in it: as the agent's user when it
// owns it (agent-user.ts) — its config and hooks are the agent's to write,
// so root never runs git there. `repo` is the shared clone, root's own.
export interface RunCheckout {
  dir: string;
  repo: string;
  git: (args: string[]) => Promise<string>;
}

export function rootCheckout(dir: string, repo: string): RunCheckout {
  return { dir, repo, git: async (args) => (await host().exec('git', args, { cwd: dir })).stdout.trim() };
}

export function agentCheckout(dir: string, repo: string, user: AgentUser): RunCheckout {
  return { dir, repo, git: async (args) => (await host().exec('git', args, asAgent(user, { cwd: dir }))).stdout.trim() };
}

async function rootGit(cwd: string, args: string[]): Promise<string> {
  return (await host().exec('git', args, { cwd })).stdout.trim();
}

export async function checkoutState(checkout: RunCheckout, scope: RunScope): Promise<CheckoutState> {
  const startSha = scope.startSha ?? 'HEAD';
  const parent = (ref: string) => checkout.git(['rev-parse', `${ref}^`]).catch(() => null);
  const contains = (ancestor: string) => checkout.git(['merge-base', '--is-ancestor', ancestor, 'HEAD']).then(() => true, () => false);
  const push = scope.push;
  return {
    head: await checkout.git(['rev-parse', 'HEAD']),
    parentOfHead: await parent('HEAD'),
    parentOfStart: await parent(startSha),
    dirty: (await checkout.git(['status', '--porcelain', '--untracked-files=no'])) !== '',
    onBase: push?.mode === 'branch' ? await contains(push.baseSha) : false,
    onStart: await contains(startSha),
  };
}

// What the agent gets back, besides "ok".
export type ActionResult = Record<string, unknown>;

// The services a run's tests need, from the repo's compose (#257): given by
// the task (domains/product-app/services.ts), which knows the compose.
// Unknown services are refused there, with the ones there are.
export interface RunServices {
  up(services: string[]): Promise<Record<string, Record<string, number>>>;
  run(service: string, command: string): Promise<{ exitCode: number; output: string }>;
  close(): Promise<void>;
}

// The checkout's HEAD into the shared repo, through a bundle the agent's
// user writes: root only ever reads a file, never runs git in the agent's
// repo. Checked again here, in root's repo — the agent could have changed
// HEAD after the action was validated: against what the push mode allows.
async function takeHead(scope: RunScope, checkout: RunCheckout): Promise<string> {
  const mode = scope.push ?? { mode: 'amend' as const };
  const start = scope.startSha!;
  // What the bundle leaves out, because root's repo already has it.
  const anchor = mode.mode === 'amend'
    ? await rootGit(checkout.repo, ['rev-parse', `${start}^`])
    : mode.mode === 'branch' ? mode.baseSha : start;
  // In the checkout's git directory: .git in a clone, but in a worktree
  // (a runner without agent users) .git is a file pointing elsewhere.
  const bundle = join(await checkout.git(['rev-parse', '--absolute-git-dir']), 'ronin-push.bundle');
  await checkout.git(['bundle', 'create', bundle, 'HEAD', `^${anchor}`]);
  const ref = `refs/ronin/push/${randomBytes(6).toString('hex')}`;
  try {
    await rootGit(checkout.repo, ['fetch', '--quiet', '--no-tags', bundle, `+HEAD:${ref}`]);
    const sha = await rootGit(checkout.repo, ['rev-parse', ref]);
    const descends = (ancestor: string) => rootGit(checkout.repo, ['merge-base', '--is-ancestor', ancestor, sha]).then(() => true, () => false);
    if (sha === start) throw new ActionRefused('no hay nada que subir: el commit es el mismo con el que empezaste');
    if (mode.mode === 'amend' && (await rootGit(checkout.repo, ['rev-parse', `${sha}^`])) !== anchor) {
      throw new ActionRefused('el commit tiene que ser un amend del commit con el que empezaste (git commit --amend), no uno nuevo');
    }
    if (mode.mode === 'branch' && !(await descends(anchor))) throw new ActionRefused('la rama tiene que salir de su base: no la rebases sobre otra cosa');
    if (mode.mode === 'fast-forward' && !(await descends(start))) throw new ActionRefused('solo commits nuevos encima del que empezaste: nunca amend, rebase ni force-push');
    return sha;
  } finally {
    await rootGit(checkout.repo, ['update-ref', '-d', ref]).catch(() => {});
  }
}

// What the branch on origin must still be for the push to go: the commit
// the run started from (amend, fast-forward), or what the branch had when
// the run started, nothing included (its own branch).
function leaseOf(scope: RunScope): string {
  const push = scope.push;
  if (push?.mode === 'branch') return `--force-with-lease=refs/heads/${scope.headRef}:${push.remoteSha ?? ''}`;
  return `--force-with-lease=refs/heads/${scope.headRef}:${scope.startSha}`;
}

// What a new description must keep of the current one: its "Closes #N"
// first line, which links the PR to its issue, and ronin's help footer, from
// its marker on. It closes no issue the current one doesn't. Null when it
// keeps them; the reason otherwise.
export function bodyKeepsWhatItMust(current: string, next: string): string | null {
  const closes = /^Closes #\d+/i.exec(current.trimStart())?.[0];
  if (closes && !next.trimStart().startsWith(closes)) return `la descripción tiene que seguir empezando con "${closes}"`;
  const had = new Set(closingRefs(current));
  const added = closingRefs(next).filter((ref) => !had.has(ref));
  if (added.length > 0) return `la descripción no puede cerrar issues que antes no cerraba: saca "${added.join('", "')}"`;
  const at = current.indexOf(HELP_FOOTER_MARKER);
  if (at >= 0 && !next.trimEnd().endsWith(current.slice(at).trimEnd())) return `todo desde la línea "${HELP_FOOTER_MARKER}" tiene que quedar exactamente como está`;
  return null;
}

export async function executeAction(scope: RunScope, checkout: RunCheckout, action: ValidAction, services?: RunServices): Promise<ActionResult> {
  switch (action.name) {
    case 'pr.reply':
      await replyToComment(prNumberOf(scope), { id: action.input.commentId, kind: 'review' }, action.input.body);
      return {};
    case 'pr.comment':
      return { url: (await postIssueComment(prNumberOf(scope), action.input.body)).url };
    case 'pr.resolve-thread':
      await resolveReviewThread(scope.threads.find((t) => t.commentId === action.input.commentId)!.threadId);
      return {};
    case 'pr.update-body': {
      const refused = bodyKeepsWhatItMust((await getPullRequestStatus(prNumberOf(scope))).body, action.input.body);
      if (refused) throw new ActionRefused(refused);
      await setPullRequestBody(prNumberOf(scope), action.input.body);
      return {};
    }
    case 'pr.create': {
      const pr = scope.pr!;
      // Only once its branch is on origin: GitHub won't open it otherwise,
      // and the agent should hear why.
      const pushed = await rootGit(checkout.repo, ['ls-remote', 'origin', `refs/heads/${scope.headRef}`]);
      if (!pushed) throw new ActionRefused('la rama no está en GitHub todavía: súbela con git.push antes de abrir el PR');
      const number = await createPullRequest({ head: scope.headRef!, base: pr.base, title: action.input.title, body: action.input.body, draft: pr.draft });
      if (pr.assignee) await addIssueAssignees(number, [pr.assignee]);
      return { number };
    }
    case 'issue.comment':
      return { url: (await postIssueComment(scope.issue!.number, action.input.body)).url };
    case 'issue.update-body': {
      const issue = scope.issue!;
      const next = issue.body === 'append' ? `${(await getIssueBody(issue.number)).trimEnd()}\n\n${action.input.body}` : action.input.body;
      await setIssueBody(issue.number, next);
      return {};
    }
    case 'git.push': {
      const sha = await takeHead(scope, checkout);
      // Leased on the commit the run started from: if someone pushed to the
      // branch meanwhile, their work stays and the agent is told.
      try {
        await rootGit(checkout.repo, ['push', leaseOf(scope), 'origin', `${sha}:refs/heads/${scope.headRef}`]);
      } catch (error) {
        const message = String((error as { stderr?: string }).stderr ?? error);
        if (/stale info|rejected/i.test(message)) throw new ActionRefused('alguien subió otro commit a la rama mientras trabajabas: no se subió nada');
        throw error;
      }
      return { sha };
    }
    case 'services.up':
      if (!services) throw new ActionRefused('esta corrida no tiene servicios');
      return { ports: await services.up(action.input.services) };
    case 'services.run':
      if (!services) throw new ActionRefused('esta corrida no tiene servicios');
      return await services.run(action.input.service, action.input.command);
    case 'result.report':
      return {};
  }
}
