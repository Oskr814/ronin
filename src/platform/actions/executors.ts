import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { postIssueComment, replyToComment, resolveReviewThread } from '../github/github.js';
import { host } from '../host/host.js';
import { asAgent, type AgentUser } from '../agents/agent-user.js';
import { ActionRefused, type CheckoutState, type RunScope, type ValidAction } from './catalog.js';

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

export async function checkoutState(checkout: RunCheckout, startSha: string): Promise<CheckoutState> {
  const parent = (ref: string) => checkout.git(['rev-parse', `${ref}^`]).catch(() => null);
  return {
    head: await checkout.git(['rev-parse', 'HEAD']),
    parentOfHead: await parent('HEAD'),
    parentOfStart: await parent(startSha),
    dirty: (await checkout.git(['status', '--porcelain', '--untracked-files=no'])) !== '',
  };
}

// What the agent gets back, besides "ok".
export type ActionResult = Record<string, string | number | boolean>;

// The checkout's HEAD into the shared repo, through a bundle the agent's
// user writes: root only ever reads a file, never runs git in the agent's
// repo. Checked again here, in root's repo — the agent could have amended
// once more after the action was validated.
async function takeHead(scope: RunScope, checkout: RunCheckout): Promise<string> {
  const bundle = join(checkout.dir, '.git', 'ronin-push.bundle');
  const parentOfStart = await rootGit(checkout.repo, ['rev-parse', `${scope.startSha}^`]);
  await checkout.git(['bundle', 'create', bundle, 'HEAD', `^${parentOfStart}`]);
  const ref = `refs/ronin/push/${randomBytes(6).toString('hex')}`;
  try {
    await rootGit(checkout.repo, ['fetch', '--quiet', '--no-tags', bundle, `+HEAD:${ref}`]);
    const sha = await rootGit(checkout.repo, ['rev-parse', ref]);
    if (sha === scope.startSha || (await rootGit(checkout.repo, ['rev-parse', `${sha}^`])) !== parentOfStart) {
      throw new ActionRefused('el commit tiene que ser un amend del commit con el que empezaste (git commit --amend), no uno nuevo');
    }
    return sha;
  } finally {
    await rootGit(checkout.repo, ['update-ref', '-d', ref]).catch(() => {});
  }
}

export async function executeAction(scope: RunScope, checkout: RunCheckout, action: ValidAction): Promise<ActionResult> {
  switch (action.name) {
    case 'pr.reply':
      await replyToComment(scope.prNumber, { id: action.input.commentId, kind: 'review' }, action.input.body);
      return {};
    case 'pr.comment':
      return { url: (await postIssueComment(scope.prNumber, action.input.body)).url };
    case 'pr.resolve-thread':
      await resolveReviewThread(scope.threads.find((t) => t.commentId === action.input.commentId)!.threadId);
      return {};
    case 'git.push': {
      const sha = await takeHead(scope, checkout);
      // Leased on the commit the run started from: if someone pushed to the
      // branch meanwhile, their work stays and the agent is told.
      try {
        await rootGit(checkout.repo, ['push', `--force-with-lease=refs/heads/${scope.headRef}:${scope.startSha}`, 'origin', `${sha}:refs/heads/${scope.headRef}`]);
      } catch (error) {
        const message = String((error as { stderr?: string }).stderr ?? error);
        if (/stale info|rejected/i.test(message)) throw new ActionRefused('alguien subió otro commit a la rama mientras trabajabas: no se subió nada');
        throw error;
      }
      return { sha };
    }
    case 'result.report':
      return {};
  }
}
