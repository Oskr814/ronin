import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logsDir } from '@platform/agents/run-files.js';
import type { RunSummary } from './run.js';
import { writeFileAtomic } from '@platform/fs/atomic-json.js';

// The runner's record of each exploration run (#155), for the dashboard's
// Corridas: who started it, what it explored, what it proposed and how it
// ended. The run file in the product repo (runs/<id>.md) says the same for
// people reading the PR, but only once the run is published, and never for
// one that failed before that.
//
// One JSON file per run in logs/exploration/<owner>-<repo>/, written when the
// worker starts and again when it ends. A run whose file still says
// `running` once the repo's exploration lock is free was cut.

export type ExplorationTrigger = { kind: 'noche' } | { kind: 'issue'; issueNumber: number } | { kind: 'manual'; by?: string };

export interface ExplorationRunFunction {
  id: string;
  charter: string;
  role: string;
  reason: string;
  status: 'explorada' | 'fallo' | 'omitida';
  viewports: string[];
  error?: string;
}

export interface ExplorationRunRecord {
  id: string;
  repo: string;
  app: string;
  trigger: ExplorationTrigger;
  startedAt: string;
  endedAt?: string;
  state: 'running' | 'ok' | 'error';
  error?: string;
  maxFunctions?: number;
  until?: string;
  // Once it ran: the run's id in the repo (runs/<runId>.md), its seed and the PR it went to.
  runId?: string;
  seed?: number;
  prNumber?: number;
  functions?: ExplorationRunFunction[];
  findings?: Array<{ id: string; titulo: string; tipo: string; gravedad: string }>;
  discarded?: number;
  inventory?: { added: string[]; retired: string[] };
  // Where it looked, when someone said (#376): the request, cut short, and
  // the functions picked by hand. `unfocused`: why it explored nothing.
  focus?: { text?: string; functions?: string[]; issue?: number };
  unfocused?: string;
}

const FOCUS_SHOWN = 300;

const dirOf = (repo: string) => join(logsDir(), 'exploration', repo.replaceAll('/', '-'));
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').slice(0, 15);

async function save(record: ExplorationRunRecord): Promise<void> {
  // Whole or not at all: the dashboard may read it halfway through.
  await writeFileAtomic(join(dirOf(record.repo), `${record.id}.json`), `${JSON.stringify(record, null, 1)}\n`);
}

export async function startRunRecord(fields: Pick<ExplorationRunRecord, 'repo' | 'app' | 'trigger' | 'maxFunctions' | 'until'>, now = new Date()): Promise<ExplorationRunRecord> {
  const record: ExplorationRunRecord = {
    id: `${stamp(now)}-${fields.app}`,
    repo: fields.repo,
    app: fields.app,
    trigger: fields.trigger,
    startedAt: now.toISOString(),
    state: 'running',
    ...(fields.maxFunctions ? { maxFunctions: fields.maxFunctions } : {}),
    ...(fields.until ? { until: fields.until } : {}),
  };
  await save(record);
  return record;
}

export function summaryFields(summary: RunSummary): Partial<ExplorationRunRecord> {
  return {
    runId: summary.runId,
    seed: summary.seed,
    functions: summary.outcomes.map((o) => ({
      id: o.planned.functionId,
      charter: o.planned.charter,
      role: o.planned.role,
      reason: o.planned.reason,
      status: o.status,
      viewports: [...new Set(o.tareas.map((t) => t.viewport))],
      ...(o.error ? { error: o.error.split('\n')[0].slice(0, 300) } : {}),
    })),
    findings: summary.findings.map((f) => ({ id: f.id, titulo: f.titulo, tipo: f.tipo, gravedad: f.gravedad })),
    discarded: summary.discarded.length,
    inventory: { added: summary.inventory.added, retired: summary.inventory.retired },
    ...(summary.focus ? { focus: { ...summary.focus, ...(summary.focus.text ? { text: summary.focus.text.slice(0, FOCUS_SHOWN) } : {}) } } : {}),
    ...(summary.unfocused ? { unfocused: summary.unfocused } : {}),
  };
}

export async function finishRunRecord(record: ExplorationRunRecord, outcome: { summary: RunSummary; prNumber: number } | { error: Error }, now = new Date()): Promise<void> {
  const done: ExplorationRunRecord = 'error' in outcome
    ? { ...record, state: 'error', error: outcome.error.message.split('\n')[0].slice(0, 300) }
    : { ...record, ...summaryFields(outcome.summary), prNumber: outcome.prNumber, state: 'ok' };
  await save({ ...done, endedAt: now.toISOString() });
}

// A repo's runs of an app, newest first.
export async function listRunRecords(repo: string, app: string, limit = 50): Promise<ExplorationRunRecord[]> {
  const names = await readdir(dirOf(repo)).catch(() => [] as string[]);
  const own = names.filter((n) => n.endsWith(`-${app}.json`)).sort().reverse().slice(0, limit);
  const records = await Promise.all(own.map((n) => readFile(join(dirOf(repo), n), 'utf8').then((raw) => JSON.parse(raw) as ExplorationRunRecord).catch(() => null)));
  return records.filter((r): r is ExplorationRunRecord => r !== null && r.app === app);
}
