import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { log, redact } from '../logger.js';
import { localDay, logsDir } from './run-files.js';
import { getDb } from '../db/db.js';
import { runEnded, runStarted } from './runs-store.js';

// One file per agent run, logs/runs/<day>/<runId>.jsonl: what the dashboard
// shows as a run's transcript, and how it knows what's running right now
// (#65). The daily tick log has the same steps, but mixed
// with everything else, and its agent_run metric is only written at the end.
//
// One JSON line per event: run_start, then text/tool/tool_error as they
// happen, then run_end. A run_start without a run_end whose pid is gone is a
// run whose process died halfway. Everything goes through redact() first, the
// same as the log: field by field, so a replacement can never break a line's JSON.
//
// With DATABASE_URL (#235, stage 3.4), the run also gets its row in the
// index (runs-store.ts) when it starts and when it ends: what the dashboard
// lists. A row that can't be written never fails the run either.

export interface RunContext {
  repo: string;
  taskType: string;
  label: string;
  issueNumber?: number;
  prNumber?: number;
  // A request of the portal (P-n), whose runs have no issue or PR (#132).
  portalRequest?: number;
  // A meeting whose notes ronin read (R-n, #62).
  meeting?: number;
  sliceIndex?: number;
  sliceTitle?: string;
  // What it's a step of (run-group.ts): "preview:<pr>:<when>".
  group?: string;
  model?: string;
  effort?: string;
  account: string;
  worktree: string;
}

// What claude-runner.ts makes of a stream-json event, already truncated the
// way the log truncates it.
export type RunStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'tool_error'; text: string };

// From the run's final `result` event.
export interface RunResult {
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type RunOutcome = 'ok' | 'error' | 'timeout' | 'usage_limit';

// A run as the dashboard lists it (domains/runs/data.ts reads it
// from the file, runs-store.ts from the database).
export type RunState = 'running' | 'cut' | RunOutcome;

export interface RunLine {
  type: string;
  [key: string]: unknown;
}

export interface RunSummary {
  runId: string;
  repo: string;
  taskType: string;
  label: string;
  issueNumber?: number;
  prNumber?: number;
  portalRequest?: number;
  meeting?: number;
  sliceIndex?: number;
  sliceTitle?: string;
  // What it's a step of (platform/agents/run-group.ts): the dashboard shows a group as one run.
  group?: string;
  model?: string;
  effort?: string;
  account: string;
  worktree: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
  state: RunState;
  steps: number;
  lastStep?: string;
}

// A step as the dashboard shows it, the last one under a run.
export function stepText(line: RunLine): string {
  // A command reads as itself ("$ pnpm test"); anything else, with its tool.
  if (line.type === 'tool') return line.name === 'Bash' ? String(line.summary) : `${line.name}: ${line.summary}`;
  return String(line.text ?? '');
}

// What runClaudeHeadless reports to while a run streams.
export interface RunSink {
  step(step: RunStep): void;
  result(result: RunResult): void;
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDay(date).replace(/-/g, '')}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class RunRecord implements RunSink {
  readonly runId: string;
  readonly path: string;
  private readonly startedAt: Date;
  private stats: RunResult = {};
  private broken = false;
  private steps = 0;
  private lastStep?: string;
  // The row's insert, which its end waits for.
  private indexed: Promise<void> = Promise.resolve();

  private constructor(context: RunContext, now: Date) {
    const subject = context.issueNumber ?? context.prNumber ?? (context.portalRequest === undefined ? (context.meeting === undefined ? undefined : `r${context.meeting}`) : `p${context.portalRequest}`);
    this.runId = [stamp(now), context.taskType, ...(subject === undefined ? [] : [subject]), randomBytes(2).toString('hex')].join('-');
    this.path = join(logsDir(), 'runs', localDay(now), `${this.runId}.jsonl`);
    this.startedAt = now;
  }

  static start(context: RunContext, now = new Date()): RunRecord {
    const record = new RunRecord(context, now);
    record.write({ type: 'run_start', runId: record.runId, ...context, pid: process.pid, startedAt: now.toISOString() });
    const db = getDb();
    if (db) record.indexed = runStarted(db, record.runId, context, now.toISOString()).catch((error) => log.error(`no se pudo indexar la corrida ${record.runId}`, error));
    return record;
  }

  step(step: RunStep): void {
    const { kind, ...fields } = step;
    this.steps++;
    this.lastStep = redact(stepText({ type: kind, ...fields }));
    this.write({ type: kind, ts: new Date().toISOString(), ...fields });
  }

  result(result: RunResult): void {
    this.stats = { ...this.stats, ...result };
  }

  async end(outcome: RunOutcome, error?: unknown, now = new Date()): Promise<void> {
    const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    const end = {
      endedAt: now.toISOString(),
      durationMs: now.getTime() - this.startedAt.getTime(),
      outcome,
      ...(message ? { error: redact(message.slice(0, 2000)) } : {}),
    };
    this.write({ type: 'run_end', ...end, ...this.stats });
    const db = getDb();
    if (!db) return;
    await this.indexed;
    await runEnded(db, this.runId, { ...end, costUsd: this.stats.costUsd, steps: this.steps, lastStep: this.lastStep })
      .catch((e) => log.error(`no se pudo indexar el final de la corrida ${this.runId}`, e));
  }

  // A record that can't be written must never fail the run it describes:
  // logged once, and the rest of that run's lines are dropped.
  private write(entry: Record<string, unknown>): void {
    if (this.broken) return;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry, (_key, value) => (typeof value === 'string' ? redact(value) : value))}\n`);
    } catch (error) {
      this.broken = true;
      log.error(`no se pudo escribir el registro de la corrida ${this.runId}`, error);
    }
  }
}
