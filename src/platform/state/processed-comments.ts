import { addReaction, botReactedBefore, type CommentKind } from '../github/github.js';
import { config } from '../config/config.js';
import { getProcessedComments, recordProcessedComment } from './local-state.js';

// Which mentions ronin is done with. ronin's 👀 on a comment only says "got
// it": the webhook server puts it there the moment the comment arrives
// (apps/api/webhooks/github.ts). Done is recorded here, in the local state, once the
// work went through — a failure records nothing and is retried, as before.
//
// Before this, the 👀 itself meant done. A comment from back then still
// counts as done if ronin's 👀 on it predates ACK_EYES_SINCE; one more than
// MAX_AGE old counts as done no matter what, which is what lets old entries
// be pruned.
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

// When the webhook server started putting 👀 as "got it" (the #70 deploy on
// the runner). A fixed date, not "when the local tracking started": the
// server's 👀 lands seconds before any handler reads the state, so a start
// taken from that first read came after the 👀 of the very comment it was
// reading — which then counted as done and went unanswered (a /help on
// redmotos/shoppingcart#849, 2026-10-16).
export const ACK_EYES_SINCE = '2026-10-16T01:03:19.475Z';

export interface TrackedComment {
  id: number;
  kind: CommentKind;
  // Always there on a comment read from GitHub; one without it counts as
  // done only once recorded.
  createdAt?: string;
  reactionsEyes: number;
}

const keyOf = (c: Pick<TrackedComment, 'id' | 'kind'>) => `${c.kind}-${c.id}`;

// The ones still to do, in order.
export async function unprocessed<T extends TrackedComment>(comments: T[]): Promise<T[]> {
  if (comments.length === 0) return [];
  const done = await getProcessedComments();
  const now = Date.now();
  // One reaction lookup per old comment with a 👀, in parallel — only for
  // comments from before ACK_EYES_SINCE. Once it says done, that's recorded,
  // so the same comment isn't looked up again on every tick (#370).
  const isDone = await Promise.all(comments.map(async (c) => {
    if (done.has(keyOf(c))) return true;
    if (!c.createdAt) return false;
    if (now - Date.parse(c.createdAt) > MAX_AGE_MS) return true;
    if (!(c.createdAt < ACK_EYES_SINCE && c.reactionsEyes > 0)) return false;
    const reacted = await botReactedBefore(c.id, c.kind, config.githubLogin, ACK_EYES_SINCE);
    if (reacted) await recordProcessedComment(keyOf(c), MAX_AGE_MS);
    return reacted;
  }));
  return comments.filter((_, i) => !isDone[i]);
}

export async function isProcessed(comment: TrackedComment): Promise<boolean> {
  return (await unprocessed([comment])).length === 0;
}

// Done with it: recorded, and its 👀 made sure of — the server's may be
// missing when the webhook never arrived and the tick found the comment.
export async function markProcessed(comment: Pick<TrackedComment, 'id' | 'kind'>): Promise<void> {
  await recordProcessedComment(keyOf(comment), MAX_AGE_MS);
  await addReaction(comment.id, comment.kind, 'eyes').catch(() => {});
}
