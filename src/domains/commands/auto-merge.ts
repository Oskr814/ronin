import { markProcessed } from '../../platform/state/processed-comments.js';
import {
  addIssueLabel,
  commentOnSpecPr,
  listOpenPrsForAutoMerge,
  mergePullRequest,
  removeIssueLabel,
  replyToComment,
  type AutoMergeCandidate,
  type Comment,
} from '../../platform/github/github.js';
import { config, LABEL_AUTO_MERGE } from '../../platform/config/config.js';
import { getAutoMergeDefaulted, setAutoMergeDefaulted } from '../../platform/state/local-state.js';
import { log } from '../../platform/logger.js';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { issueFromSliceBranch } from '../slices/stack.js';

// `@ronin-agent /auto-merge` on a PR, ronin's take on GitHub's auto-merge
// (an Enterprise/paid-plan feature): the PR is merged as soon as it's
// approved and its checks are green. The ronin:auto-merge label is the whole
// state — the command only puts it on or takes it off, a human can set it by
// hand, and removing it cancels. sweepAutoMerge does the merging, every
// tick. See docs/DESIGN.md §13.
//
// Like GitHub's, it turns itself off (label removed, PR told) when the PR
// conflicts with its base or the merge itself fails; anything else that's
// missing (the approval, CI) it just waits for.
//
// ronin's own slice PRs get the label by default (the repo's `autoMerge` in
// repos.json, on unless set to false): an approval is then all it takes. Spec and
// exploration PRs are left out, since each has its own merge — see
// labelNewSlicePrs.

export type AutoMergeAction = 'on' | 'off';

export interface AutoMergeBlockers {
  // Why it has to be turned off, if it does.
  disable?: string;
  // What it's still waiting for; empty means it can merge.
  waits: string[];
}

// `openPrsByHead`: every open PR's head branch → its number, to tell a PR
// stacked on another one (its base is that one's branch) — merging it now
// would land it in that branch, not in the root.
export function autoMergeBlockers(candidate: Pick<AutoMergeCandidate, 'status' | 'conflicting'>, openPrsByHead: Map<string, number>): AutoMergeBlockers {
  const pr = candidate.status;
  if (candidate.conflicting) return { disable: `tiene conflictos con \`${pr.baseRefName}\``, waits: [] };
  const waits: string[] = [];
  if (pr.isDraft) waits.push('que deje de ser draft');
  const below = openPrsByHead.get(pr.baseRefName);
  if (below !== undefined && below !== pr.number) waits.push(`que se mergee #${below}, que está abajo en el stack`);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') waits.push('que se resuelvan los cambios pedidos y lo aprueben');
  else if (pr.reviewDecision !== 'APPROVED') waits.push('una aprobación');
  if (pr.checksPending) waits.push('que terminen los checks');
  else if (!pr.checksPassing) waits.push('que pasen los checks que están fallando');
  else if (!pr.mergeable) waits.push('que GitHub lo dé por mergeable');
  return { waits };
}

function headIndex(candidates: AutoMergeCandidate[]): Map<string, number> {
  return new Map(candidates.map((c) => [c.status.headRefName, c.status.number]));
}

// Merges every labeled PR that's ready, and turns auto-merge off on the
// ones that can't be merged anymore. Costs one `gh pr list` per tick. Only
// a merge or a turn-off is said on the PR; waiting is just logged, every
// tick, so the PR doesn't fill up with "still waiting".
export async function sweepAutoMerge(): Promise<void> {
  const candidates = await listOpenPrsForAutoMerge();
  if (activeRepo().autoMerge !== false) await labelNewSlicePrs(candidates);
  const labeled = candidates.filter((c) => c.labels.includes(LABEL_AUTO_MERGE));
  if (labeled.length === 0) return;
  const heads = headIndex(candidates);
  for (const candidate of labeled) {
    const prNumber = candidate.status.number;
    const blockers = autoMergeBlockers(candidate, heads);
    if (blockers.disable) {
      await turnOff(prNumber, blockers.disable);
      continue;
    }
    if (blockers.waits.length > 0) {
      log.info(`auto-merge PR #${prNumber}: esperando ${blockers.waits.join(', ')}`);
      continue;
    }
    try {
      await mergePullRequest(prNumber);
      log.info(`auto-merge PR #${prNumber}: mergeado`);
    } catch (error) {
      log.error(`auto-merge PR #${prNumber}: el merge falló`, error);
      await turnOff(prNumber, `el merge falló (${(error as Error).message.split('\n')[0].slice(0, 300)})`);
      continue;
    }
    await commentOnSpecPr(prNumber, renderAutoMerged())
      .catch((error) => log.error(`auto-merge PR #${prNumber}: mergeado, pero no se pudo avisar en el PR`, error));
  }
}

// Puts the label on each slice PR the first time it's seen open, once:
// taking it off by hand or with `/auto-merge off` sticks. A PR that already
// conflicts is recorded without it, as the command would refuse it. The
// first run only records the open ones, so turning this on doesn't merge
// what was already waiting for review. `candidates` is updated in place.
export async function labelNewSlicePrs(candidates: AutoMergeCandidate[]): Promise<void> {
  const slices = candidates.filter((c) => issueFromSliceBranch(c.status.headRefName) !== null);
  const seen = await getAutoMergeDefaulted();
  const open = slices.map((c) => c.status.number);
  if (seen === undefined) {
    await setAutoMergeDefaulted(open);
    return;
  }
  const done = new Set(seen);
  const fresh = slices.filter((c) => !done.has(c.status.number));
  if (fresh.length === 0 && seen.length === open.length) return;
  const failed = new Set<number>();
  for (const candidate of fresh) {
    const prNumber = candidate.status.number;
    if (candidate.labels.includes(LABEL_AUTO_MERGE) || candidate.conflicting) continue;
    try {
      await addIssueLabel(prNumber, LABEL_AUTO_MERGE);
      candidate.labels.push(LABEL_AUTO_MERGE);
      log.info(`auto-merge PR #${prNumber}: activado por defecto`);
    } catch (error) {
      failed.add(prNumber);
      log.error(`auto-merge PR #${prNumber}: no se pudo poner el label por defecto`, error);
    }
  }
  await setAutoMergeDefaulted(open.filter((n) => !failed.has(n)));
}

async function turnOff(prNumber: number, reason: string): Promise<void> {
  try {
    await removeIssueLabel(prNumber, LABEL_AUTO_MERGE);
    await commentOnSpecPr(prNumber, renderAutoMergeDisabled(reason, config.githubLogin));
    log.info(`auto-merge PR #${prNumber}: desactivado, ${reason}`);
  } catch (error) {
    log.error(`auto-merge PR #${prNumber}: no se pudo desactivar (${reason})`, error);
  }
}

// The command itself: puts the label on or off and answers in the comment's
// own place with what the merge is still waiting for — or, for a PR that
// already conflicts, why it wasn't turned on. It's marked done last,
// so a failure halfway is retried next tick (adding or removing the label
// twice is harmless).
export async function applyAutoMergeCommand(prNumber: number, comment: Pick<Comment, 'id' | 'kind'>, action: AutoMergeAction): Promise<void> {
  const login = config.githubLogin;
  if (action === 'off') {
    await removeIssueLabel(prNumber, LABEL_AUTO_MERGE).catch((error) => {
      // gh fails when the label isn't on the PR: that's already "off".
      log.info(`auto-merge PR #${prNumber}: sacar el label falló, lo doy por apagado (${(error as Error).message.split('\n')[0]})`);
    });
    await replyToComment(prNumber, comment, renderAutoMergeOff(login));
  } else {
    const candidates = await listOpenPrsForAutoMerge();
    const candidate = candidates.find((c) => c.status.number === prNumber);
    const blockers = candidate
      ? autoMergeBlockers(candidate, headIndex(candidates))
      : { disable: 'ya no está abierto', waits: [] };
    if (!blockers.disable) await addIssueLabel(prNumber, LABEL_AUTO_MERGE);
    await replyToComment(prNumber, comment, renderAutoMergeOn(blockers, login));
  }
  await markProcessed(comment);
}

// --- replies ---

export function renderAutoMergeOn(blockers: AutoMergeBlockers, login: string): string {
  const cancel = `Para cancelarlo: \`@${login} /auto-merge off\`, o sacá el label \`${LABEL_AUTO_MERGE}\`.`;
  if (blockers.disable) {
    return `⚠️ No activé el auto-merge: este PR ${blockers.disable}. Cuando esté resuelto, volvé a pedir \`@${login} /auto-merge\`.`;
  }
  const status = blockers.waits.length === 0
    ? 'Ya está aprobado y en verde: lo mergeo en el próximo tick.'
    : `Falta: ${blockers.waits.join(', ')}.`;
  return `🔀 Auto-merge activado: mergeo este PR apenas esté aprobado y con los checks en verde. ${status} ${cancel}`;
}

export function renderAutoMergeOff(login: string): string {
  return `Auto-merge desactivado: este PR no se va a mergear solo. Para volver a activarlo: \`@${login} /auto-merge\`.`;
}

export function renderAutoMerged(): string {
  return '✅ Mergeado por auto-merge: estaba aprobado y con los checks en verde.';
}

export function renderAutoMergeDisabled(reason: string, login: string): string {
  return `⚠️ Desactivé el auto-merge de este PR: ${reason}. Cuando esté resuelto, volvé a pedir \`@${login} /auto-merge\`.`;
}
