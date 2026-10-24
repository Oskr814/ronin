import { sql } from 'kysely';
import type { Db } from '@platform/db/db.js';
import { publishQuietly } from '@platform/events/bus.js';

// The team's decision on each finding of an exploration PR (#446): approve
// or reject, kept in ronin instead of a comment on its file, so everyone
// reviewing sees it at once (platform/events/bus.ts) and nothing waits on an
// agent. Finishing the review writes them into the PR (flow.ts's
// approveAndMerge): the rejected ones with their reason, the rest approved.

export type FindingDecisionKind = 'aprobar' | 'rechazar';

export interface FindingDecision {
  ficha: string;
  decision: FindingDecisionKind;
  reason: string | null;
  by: string;
  at: string;
  applied: boolean;
}

const COLUMNS = ['ficha', 'decision', 'reason', 'decided_by', 'decided_at', 'applied_at'] as const;
type Row = { ficha: string; decision: string; reason: string | null; decided_by: string; decided_at: Date; applied_at: Date | null };
const toDecision = (row: Row): FindingDecision => ({ ficha: row.ficha, decision: row.decision as FindingDecisionKind, reason: row.reason, by: row.decided_by, at: row.decided_at.toISOString(), applied: row.applied_at !== null });

function told(db: Db, repo: string, pr: number, ficha: string): void {
  publishQuietly(db, { type: 'ficha', repo, number: pr, ficha });
}

// Decides on one, or changes what was decided while it isn't written yet.
export async function decide(db: Db, repo: string, pr: number, ficha: string, decision: FindingDecisionKind, by: string, reason?: string): Promise<FindingDecision> {
  const row = await db.insertInto('finding_decisions')
    .values({ repo, pr, ficha, decision, reason: reason ?? null, decided_by: by })
    .onConflict((oc) => oc.columns(['repo', 'pr', 'ficha']).doUpdateSet({ decision, reason: reason ?? null, decided_by: by, decided_at: sql<string>`now()` }).where('finding_decisions.applied_at', 'is', null))
    .returning(COLUMNS)
    .executeTakeFirst();
  if (!row) throw new Error(`${ficha} ya quedó escrita en el PR`);
  told(db, repo, pr, ficha);
  return toDecision(row);
}

// Takes it back, while it isn't written yet. Whether there was one to take back.
export async function undecide(db: Db, repo: string, pr: number, ficha: string): Promise<boolean> {
  const gone = await db.deleteFrom('finding_decisions')
    .where('repo', '=', repo).where('pr', '=', pr).where('ficha', '=', ficha).where('applied_at', 'is', null)
    .executeTakeFirst();
  const any = Number(gone.numDeletedRows) > 0;
  if (any) told(db, repo, pr, ficha);
  return any;
}

export async function listDecisions(db: Db, repo: string, pr: number): Promise<FindingDecision[]> {
  const rows = await db.selectFrom('finding_decisions').select(COLUMNS).where('repo', '=', repo).where('pr', '=', pr).orderBy('decided_at').execute();
  return rows.map(toDecision);
}

// Written into the PR: they stay as a record, and can't change anymore.
export async function markApplied(db: Db, repo: string, pr: number, fichas: string[]): Promise<void> {
  if (!fichas.length) return;
  await db.updateTable('finding_decisions').set({ applied_at: sql<string>`now()` })
    .where('repo', '=', repo).where('pr', '=', pr).where('ficha', 'in', fichas).execute();
  publishQuietly(db, { type: 'ficha', repo, number: pr });
}
