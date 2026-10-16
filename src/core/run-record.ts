import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { log, redact } from './logger.js';
import { localDay, logsDir } from './run-files.js';

// One file per agent run, logs/runs/<day>/<runId>.jsonl: what the dashboard
// shows as a run's transcript, and how it knows what's running right now
// (docs/DESIGN.md §15.4). The daily tick log has the same steps, but mixed
// with everything else, and its agent_run metric is only written at the end.
//
// One JSON line per event: run_start, then text/tool/tool_error as they
// happen, then run_end. A run_start without a run_end whose pid is gone is a
// run whose process died halfway. Everything goes through redact() first, the
// same as the log: field by field, so a replacement can never break a line's JSON.

export interface RunContext {
  repo: string;
  taskType: string;
  label: string;
  issueNumber?: number;
  prNumber?: number;
  sliceIndex?: number;
  sliceTitle?: string;
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

  private constructor(context: RunContext, now: Date) {
    const subject = context.issueNumber ?? context.prNumber;
    this.runId = [stamp(now), context.taskType, ...(subject === undefined ? [] : [subject]), randomBytes(2).toString('hex')].join('-');
    this.path = join(logsDir(), 'runs', localDay(now), `${this.runId}.jsonl`);
    this.startedAt = now;
  }

  static start(context: RunContext, now = new Date()): RunRecord {
    const record = new RunRecord(context, now);
    record.write({ type: 'run_start', runId: record.runId, ...context, pid: process.pid, startedAt: now.toISOString() });
    return record;
  }

  step(step: RunStep): void {
    const { kind, ...fields } = step;
    this.write({ type: kind, ts: new Date().toISOString(), ...fields });
  }

  result(result: RunResult): void {
    this.stats = { ...this.stats, ...result };
  }

  end(outcome: RunOutcome, error?: unknown, now = new Date()): void {
    const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    this.write({
      type: 'run_end',
      endedAt: now.toISOString(),
      durationMs: now.getTime() - this.startedAt.getTime(),
      outcome,
      ...(message ? { error: message.slice(0, 2000) } : {}),
      ...this.stats,
    });
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
