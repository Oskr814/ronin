import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Lives in ronin's own checkout, never in the product repo: the external
// review worktree is the head of an untrusted PR, and a PR must not be able to
// rewrite the criteria it is reviewed against. Read on every run (same pattern
// as templates/tracking-issue.md in tick.ts), so tuning it needs no rebuild —
// see docs/superpowers/specs/2026-10-10-exhaustive-external-review-design.md.
export const REVIEW_CRITERIA_PATH = 'prompts/external-review-criteria.md';

// Same hash `git hash-object` computes — the ronin:finding marker records it,
// so `git log --find-object=<hash>` finds the exact criteria version a finding
// was produced with. Hashed over the raw bytes: the blob header carries the
// byte length, which differs from the character length for non-ASCII text.
function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export async function loadReviewCriteria(): Promise<{ text: string; blobHash: string }> {
  const content = await readFile(join(process.cwd(), REVIEW_CRITERIA_PATH));
  return { text: content.toString('utf8'), blobHash: gitBlobHash(content) };
}
