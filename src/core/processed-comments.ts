import { addReaction, botReactedBefore } from './github.js';
import { config } from './config.js';
import { getProcessedComments, recordProcessedComment } from './local-state.js';

// Which mentions ronin is done with. ronin's 👀 on a comment only says "got
// it": the webhook server puts it there the moment the comment arrives
// (webhooks/server.ts). Done is recorded here, in the local state, once the
// work went through — a failure records nothing and is retried, as before.
//
// Before this, the 👀 itself meant done. A comment from back then still
// counts as done if ronin's 👀 on it predates the local tracking (`since`);
// one more than MAX_AGE old counts as done no matter what, which is what
// lets old entries be pruned.
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export interface TrackedComment {
  id: number;
  kind: 'issue' | 'review';
  // Always there on a comment read from GitHub; one without it counts as
  // done only once recorded.
  createdAt?: string;
  reactionsEyes: number;
}

const keyOf = (c: Pick<TrackedComment, 'id' | 'kind'>) => `${c.kind}-${c.id}`;

// The ones still to do, in order.
export async function unprocessed<T extends TrackedComment>(comments: T[]): Promise<T[]> {
  if (comments.length === 0) return [];
  const { since, done } = await getProcessedComments();
  const now = Date.now();
  // One reaction lookup per old comment with a 👀, in parallel — only for
  // comments from before the local tracking.
  const isDone = await Promise.all(comments.map(async (c) => {
    if (done.has(keyOf(c))) return true;
    if (!c.createdAt) return false;
    if (now - Date.parse(c.createdAt) > MAX_AGE_MS) return true;
    return c.createdAt < since && c.reactionsEyes > 0 && botReactedBefore(c.id, c.kind, config.githubLogin, since);
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
