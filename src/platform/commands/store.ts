import { sql } from 'kysely';
import type { Db } from '@platform/db/db.js';
import { publishQuietly } from '@platform/events/bus.js';

// What someone asked ronin for from the tablero (#446), instead of a
// comment on GitHub: who asked for what on which issue or PR, how it's
// going and what ronin answered. Every change is told to the screens open
// on it (platform/events/bus.ts).

export type CommandStatus = 'queued' | 'running' | 'done' | 'failed';

export interface CommandMessage {
  at: string;
  text: string;
}

export interface Command {
  id: string;
  repo: string;
  number: number;
  kind: string;
  args: Record<string, unknown>;
  requestedBy: string;
  status: CommandStatus;
  messages: CommandMessage[];
  runId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type Row = {
  id: string; repo: string; number: number; kind: string; args: unknown; requested_by: string; status: string; messages: unknown;
  run_id: string | null; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};

const toCommand = (row: Row): Command => ({
  id: String(row.id),
  repo: row.repo,
  number: row.number,
  kind: row.kind,
  args: (row.args ?? {}) as Record<string, unknown>,
  requestedBy: row.requested_by,
  status: row.status as CommandStatus,
  messages: (row.messages ?? []) as CommandMessage[],
  runId: row.run_id,
  error: row.error,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
});

const COLUMNS = ['id', 'repo', 'number', 'kind', 'args', 'requested_by', 'status', 'messages', 'run_id', 'error', 'created_at', 'started_at', 'finished_at'] as const;

function told(db: Db, command: Command): Command {
  publishQuietly(db, { type: 'command', repo: command.repo, number: command.number, id: command.id, kind: command.kind, status: command.status });
  return command;
}

export interface NewCommand {
  repo: string;
  number: number;
  kind: string;
  args?: Record<string, unknown>;
  requestedBy: string;
  // The same thing asked again while the first still waits or runs gets the first.
  dedupeKey?: string;
}

// Queues one. With a dedupe key already waiting or running, nothing new:
// `existing` is that one, with who asked for it.
export async function createCommand(db: Db, given: NewCommand): Promise<{ command: Command; existing: boolean }> {
  const inserted = await db.insertInto('commands')
    .values({ repo: given.repo, number: given.number, kind: given.kind, args: JSON.stringify(given.args ?? {}), requested_by: given.requestedBy, dedupe_key: given.dedupeKey ?? null, status: 'queued' })
    .onConflict((oc) => oc.column('dedupe_key').where('status', 'in', ['queued', 'running']).doNothing())
    .returning(COLUMNS)
    .executeTakeFirst();
  if (inserted) return { command: told(db, toCommand(inserted)), existing: false };
  const open = await db.selectFrom('commands').select(COLUMNS)
    .where('dedupe_key', '=', given.dedupeKey ?? null).where('status', 'in', ['queued', 'running'])
    .executeTakeFirstOrThrow();
  return { command: toCommand(open), existing: true };
}

export async function getCommand(db: Db, id: string): Promise<Command | null> {
  const row = await db.selectFrom('commands').select(COLUMNS).where('id', '=', id).executeTakeFirst();
  return row ? toCommand(row) : null;
}

// Its worker took it.
export async function startCommand(db: Db, id: string): Promise<Command | null> {
  const row = await db.updateTable('commands').set({ status: 'running', started_at: sql<string>`now()` })
    .where('id', '=', id).returning(COLUMNS).executeTakeFirst();
  return row ? told(db, toCommand(row)) : null;
}

// What ronin answers, in the order it does: what it's doing, and how it went.
export async function noteCommand(db: Db, id: string, text: string, runId?: string): Promise<Command | null> {
  const message = JSON.stringify([{ at: new Date().toISOString(), text }]);
  const row = await db.updateTable('commands')
    .set({ messages: sql<string>`messages || ${message}::jsonb`, ...(runId ? { run_id: runId } : {}) })
    .where('id', '=', id).returning(COLUMNS).executeTakeFirst();
  return row ? told(db, toCommand(row)) : null;
}

export async function finishCommand(db: Db, id: string, outcome: { error?: string } = {}): Promise<Command | null> {
  const row = await db.updateTable('commands')
    .set({ status: outcome.error ? 'failed' : 'done', error: outcome.error ?? null, finished_at: sql<string>`now()` })
    .where('id', '=', id).returning(COLUMNS).executeTakeFirst();
  return row ? told(db, toCommand(row)) : null;
}

// An item's commands (its issue and its PR), newest first.
export async function listCommands(db: Db, repo: string, numbers: number[], limit = 50): Promise<Command[]> {
  if (!numbers.length) return [];
  const rows = await db.selectFrom('commands').select(COLUMNS)
    .where('repo', '=', repo).where('number', 'in', numbers)
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  return rows.map(toCommand);
}

// Takes a waiting one to work on it: only one process gets it. Null when
// someone else took it first, or it's no longer waiting.
export async function claimCommand(db: Db, id: string): Promise<Command | null> {
  const row = await db.updateTable('commands').set({ status: 'running', started_at: sql<string>`now()` })
    .where('id', '=', id).where('status', '=', 'queued').returning(COLUMNS).executeTakeFirst();
  return row ? told(db, toCommand(row)) : null;
}

// Back to waiting, for the next run to try again: what went wrong, said.
export async function requeueCommand(db: Db, id: string, why?: string): Promise<void> {
  if (why) await noteCommand(db, id, why);
  const row = await db.updateTable('commands').set({ status: 'queued', started_at: null })
    .where('id', '=', id).where('status', '=', 'running').returning(COLUMNS).executeTakeFirst();
  if (row) told(db, toCommand(row));
}

// What's waiting on an issue or PR, oldest first: `kinds`, the ones the caller answers.
export async function waitingCommands(db: Db, repo: string, number: number, kinds: string[]): Promise<Command[]> {
  if (!kinds.length) return [];
  const rows = await db.selectFrom('commands').select(COLUMNS)
    .where('repo', '=', repo).where('number', '=', number).where('kind', 'in', kinds).where('status', '=', 'queued')
    .orderBy('created_at').orderBy('id').execute();
  return rows.map(toCommand);
}
