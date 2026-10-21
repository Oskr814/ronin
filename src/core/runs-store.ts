import { hostname } from 'node:os';
import { sql, type Selectable } from 'kysely';
import type { Db } from '../db/db.js';
import type { RunsTable } from '../db/schema.js';
import type { RunContext, RunOutcome, RunSummary } from './run-record.js';

// The index of the agents' runs in Postgres (#235, stage 3.4), with
// DATABASE_URL: what the dashboard lists, without walking logs/runs/. The
// run's process writes its row when it starts (runStarted) and when it ends
// (runEnded); the transcript stays its file.

const HOST = hostname();
const runDay = (runId: string) => `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}`;
const orNull = <T>(value: T | undefined): T | null => value ?? null;

export async function runStarted(db: Db, runId: string, context: RunContext, startedAt: string, pid = process.pid): Promise<void> {
  await db.insertInto('runs').values({
    run_id: runId,
    day: runDay(runId),
    repo: context.repo,
    task_type: context.taskType,
    label: context.label,
    issue_number: orNull(context.issueNumber),
    pr_number: orNull(context.prNumber),
    portal_request: orNull(context.portalRequest),
    meeting: orNull(context.meeting),
    slice_index: orNull(context.sliceIndex),
    slice_title: orNull(context.sliceTitle),
    grp: orNull(context.group),
    model: orNull(context.model),
    effort: orNull(context.effort),
    account: context.account,
    worktree: context.worktree,
    host: HOST,
    pid,
    started_at: startedAt,
  }).onConflict((oc) => oc.column('run_id').doNothing()).execute();
}

export interface RunEnd {
  endedAt: string;
  durationMs: number;
  outcome: RunOutcome;
  costUsd?: number;
  error?: string;
  steps: number;
  lastStep?: string;
}

export async function runEnded(db: Db, runId: string, end: RunEnd): Promise<void> {
  await db.updateTable('runs').set({
    ended_at: end.endedAt,
    duration_ms: end.durationMs,
    outcome: end.outcome,
    cost_usd: orNull(end.costUsd),
    error: orNull(end.error),
    steps: end.steps,
    last_step: orNull(end.lastStep),
    updated_at: sql<string>`now()`,
  }).where('run_id', '=', runId).execute();
}

// A run as its file says it, whole: for the import, and to catch up a row
// whose end didn't make it (the database was down when the run ended).
export async function putRun(db: Db, run: RunSummary, pid?: number): Promise<void> {
  const { runId, repo, taskType, label, account, worktree, startedAt } = run;
  await db.deleteFrom('runs').where('run_id', '=', runId).execute();
  await runStarted(db, runId, { repo, taskType, label, account, worktree, issueNumber: run.issueNumber, prNumber: run.prNumber, portalRequest: run.portalRequest, meeting: run.meeting, sliceIndex: run.sliceIndex, sliceTitle: run.sliceTitle, group: run.group, model: run.model, effort: run.effort }, startedAt, pid);
  if (run.endedAt) {
    await runEnded(db, runId, { endedAt: run.endedAt, durationMs: run.durationMs ?? 0, outcome: run.state as RunOutcome, costUsd: run.costUsd, error: run.error, steps: run.steps, lastStep: run.lastStep });
  } else {
    await db.updateTable('runs').set({ steps: run.steps, last_step: orNull(run.lastStep) }).where('run_id', '=', runId).execute();
  }
}

// The runs of these days (local, as the files' folders), newest first. One
// still going comes without its state (running or cut) nor its steps: the
// caller reads them from its file, which has them as they happen.
export async function listRunsDb(db: Db, days: string[]): Promise<Array<{ summary: RunSummary; pid: number | null; host: string | null }>> {
  if (days.length === 0) return [];
  const rows = await db.selectFrom('runs').selectAll().where('day', 'in', days).orderBy('started_at', 'desc').execute();
  return rows.map((row) => ({ summary: toSummary(row), pid: row.pid, host: row.host }));
}

function toSummary(row: Selectable<RunsTable>): RunSummary {
  const opt = <K extends string, V>(key: K, value: V | null) => (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>;
  return {
    runId: row.run_id,
    repo: row.repo,
    taskType: row.task_type,
    label: row.label,
    ...opt('issueNumber', row.issue_number),
    ...opt('prNumber', row.pr_number),
    ...opt('portalRequest', row.portal_request),
    ...opt('meeting', row.meeting),
    ...(row.slice_index === null ? {} : { sliceIndex: row.slice_index, sliceTitle: row.slice_title ?? undefined }),
    ...opt('group', row.grp),
    ...opt('model', row.model),
    ...opt('effort', row.effort),
    account: row.account,
    worktree: row.worktree,
    startedAt: row.started_at.toISOString(),
    ...(row.ended_at ? { endedAt: row.ended_at.toISOString(), durationMs: row.duration_ms ?? 0 } : {}),
    ...opt('costUsd', row.cost_usd),
    ...opt('error', row.error),
    state: (row.outcome as RunOutcome | null) ?? 'running',
    steps: row.steps,
    ...opt('lastStep', row.last_step),
  };
}

export const thisHost = (): string => HOST;
