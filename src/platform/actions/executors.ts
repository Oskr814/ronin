import { postIssueComment, replyToComment, resolveReviewThread } from '../github/github.js';
import { host } from '../host/host.js';
import { ActionRefused, type CheckoutState, type RunScope, type ValidAction } from './catalog.js';

// What each action does, once catalog.ts accepted it: as ronin, with its
// write token — the agent only ever sees the result. Called inside the
// run's withActiveRepo, so github.ts writes to the run's repo.

async function git(dir: string, args: string[]): Promise<string> {
  return (await host().exec('git', args, { cwd: dir })).stdout.trim();
}

export async function headOf(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

export async function checkoutState(dir: string, startSha: string): Promise<CheckoutState> {
  const parent = (ref: string) => git(dir, ['rev-parse', `${ref}^`]).catch(() => null);
  return {
    head: await git(dir, ['rev-parse', 'HEAD']),
    parentOfHead: await parent('HEAD'),
    parentOfStart: await parent(startSha),
    dirty: (await git(dir, ['status', '--porcelain', '--untracked-files=no'])) !== '',
  };
}

// What the agent gets back, besides "ok".
export type ActionResult = Record<string, string | number | boolean>;

export async function executeAction(scope: RunScope, checkoutDir: string, action: ValidAction): Promise<ActionResult> {
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
      // Leased on the commit the run started from: if someone pushed to the
      // branch meanwhile, their work stays and the agent is told.
      const sha = await git(checkoutDir, ['rev-parse', 'HEAD']);
      try {
        await git(checkoutDir, ['push', `--force-with-lease=refs/heads/${scope.headRef}:${scope.startSha}`, 'origin', `HEAD:refs/heads/${scope.headRef}`]);
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
